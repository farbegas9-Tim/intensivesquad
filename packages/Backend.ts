// 在Node.js环境中提供全局的fetch实现
// 使用node-fetch v2并完全忽略类型检查以避免与lib.dom.d.ts的冲突
// @ts-nocheck
const fetch = require('node-fetch');
// @ts-ignore
globalThis.fetch = fetch;
// @ts-ignore
globalThis.Request = fetch.Request;
// @ts-ignore
globalThis.Headers = fetch.Headers;
// @ts-ignore
globalThis.Response = fetch.Response;

// @ts-check
import { createPublicClient, http} from 'viem';
import { mainnet } from 'viem/chains';
import erc20Abi from  '../abi/erc20.json';
import dotenv from 'dotenv';
import Redis from 'ioredis';

// 初始化环境变量和Redis
dotenv.config();

// 环境变量验证
if (!process.env.RPC_URL_HTTP) {
  console.error('错误: 缺少RPC_URL_HTTP环境变量');
  process.exit(1);
}

if (!process.env.TARGET_CONTRACT_ADDRESS) {
  console.error('错误: 缺少TARGET_CONTRACT_ADDRESS环境变量');
  process.exit(1);
}

// Redis连接和内存存储备选方案
let redis: any = null;
let useInMemoryStorage = false;
let lastProcessedBlockInMemory = BigInt(0) as bigint;

// 尝试连接到Redis，如果失败则使用内存存储
async function initializeStorage() {
  if (process.env.REDIS_URL) {
    try {
      // 配置Redis连接参数，减少重试次数和超时
      const redisConfig = {
        host: 'localhost',
        port: 6379,
        retryStrategy: (times: number) => {
          if (times > 3) {
            console.error('[Redis] 连接重试次数过多，放弃连接');
            return null;
          }
          return Math.min(times * 100, 300);
        },
        connectTimeout: 2000,
        maxRetriesPerRequest: 1
      };
      
      redis = new Redis(redisConfig);
      
      // 监听Redis连接错误
      redis.on('error', (error: Error) => {
        console.error('[Redis] 连接错误:', error.message);
        
        // 如果之前没有使用内存存储，则切换到内存存储
        if (!useInMemoryStorage) {
          console.warn('[Storage] 切换到内存存储模式');
          // 移除所有监听器并关闭连接
          if (redis) {
            redis.removeAllListeners();
            redis.disconnect(false);
          }
          useInMemoryStorage = true;
          redis = null;
        }
      });
      
      // 验证连接
      await redis.ping();
      console.log('[Redis] 连接成功');
      
      // 如果是内存存储切换到Redis，恢复区块号
      if (useInMemoryStorage) {
        const redisLastBlock = await redis.get(REDIS_LAST_BLOCK_KEY);
        if (redisLastBlock) {
          lastProcessedBlockInMemory = BigInt(redisLastBlock);
          console.log('[Storage] 从Redis恢复区块号:', lastProcessedBlockInMemory);
        }
      }
      
      return;
    } catch (error) {
      console.error('[Redis] 初始化失败:', (error as Error).message);
      // 确保在初始化失败时清理资源
      if (redis) {
        try {
          redis.removeAllListeners();
          redis.disconnect(false);
        } catch (e) {
          // 忽略关闭时的错误
        }
        redis = null;
      }
    }
  }
  
  // 使用内存存储作为备选
  console.warn('[Storage] 使用内存存储模式（适合开发和测试）');
  useInMemoryStorage = true;
  redis = null;
  
  // 检查是否有环境变量设置的初始区块号
  if (process.env.INITIAL_BLOCK_NUMBER) {
    try {
      const initialBlock = BigInt(process.env.INITIAL_BLOCK_NUMBER);
      if (initialBlock > 0) {
        lastProcessedBlockInMemory = initialBlock;
        console.log('[Storage] 使用环境变量设置的初始区块号:', lastProcessedBlockInMemory);
      }
    } catch (error) {
      console.error('[Storage] 解析INITIAL_BLOCK_NUMBER环境变量失败:', (error as Error).message);
    }
  }
}

// 环境变量配置
const TARGET_CONTRACT_ADDRESS = process.env.TARGET_CONTRACT_ADDRESS as `0x${string}`;
// const CREDIT_COLLECTOR_EOA = process.env.CREDIT_COLLECTOR_EOA as `0x${string}`;
const REDIS_LAST_BLOCK_KEY = 'lastProcessedBlock';
const USDT_DECIMAL = 6; // USDT精度（主网是6，BSC通常是18）

// 创建链的公共客户端
const publicClient = createPublicClient({
  chain: mainnet,
  transport: http(process.env.RPC_URL_HTTP), // 替换为实际RPC URL
  batch: {
    multicall: true
  }
});

// 获取最后处理的区块号（兼容Redis和内存存储）
async function getLastProcessedBlock(): Promise<bigint> {
  try {
    if (useInMemoryStorage) {
      return lastProcessedBlockInMemory;
    }
    
    const lastBlock = await redis.get(REDIS_LAST_BLOCK_KEY);
    return lastBlock ? BigInt(lastBlock) : BigInt(0);
  } catch (error) {
    console.error('[Storage] 获取最后处理区块号失败:', (error as Error).message);
    // 出错时使用内存存储的区块号
    return lastProcessedBlockInMemory;
  }
}

// 设置最后处理的区块号（兼容Redis和内存存储）
async function setLastProcessedBlock(blockNumber: bigint): Promise<void> {
  try {
    // 更新内存中的区块号（无论使用哪种存储方式）
    lastProcessedBlockInMemory = blockNumber;
    
    if (!useInMemoryStorage) {
      await redis.set(REDIS_LAST_BLOCK_KEY, blockNumber.toString());
    }
  } catch (error) {
    console.error('[Storage] 设置最后处理区块号失败:', (error as Error).message);
    // 出错时确保内存中的区块号已更新
    lastProcessedBlockInMemory = blockNumber;
  }
}


async function processDeposits() {
  try {
    const startTime = Date.now();
    // 从存储获取上次处理的区块号
    const lastProcessedBlock = await getLastProcessedBlock();
    let fromBlock = lastProcessedBlock + BigInt(1);
    
    // 获取当前区块号（添加错误处理）
    let toBlock: bigint;
    try {
      toBlock = await publicClient.getBlockNumber();
      console.log(`[Ethereum] 当前区块号: ${toBlock}`);
    } catch (error) {
      console.error('[Ethereum] 获取区块号失败:', error instanceof Error ? error.message : String(error));
      // 使用上次的区块号 + 100作为临时区块范围，避免因RPC问题完全停止
      toBlock = lastProcessedBlock + BigInt(100);
      console.warn(`[Ethereum] 使用临时区块范围: ${fromBlock} → ${toBlock}`);
    }
    
    if (fromBlock > toBlock) {
      console.log("[Deposit Monitor] 没有新区块需要处理");
      return;
    }

    console.log(`[Deposit Monitor] 扫描区块: ${fromBlock} → ${toBlock}`);

    // 查询符合条件的Transfer事件，使用分块处理
    let logs: any[] = [];
    try {
      logs = await publicClient.getContractEvents({
        address: TARGET_CONTRACT_ADDRESS,
        abi: erc20Abi,
        eventName: "Transfer",
      //   args: { to: CREDIT_COLLECTOR_EOA }, // 只监听转入特定地址的事件
        fromBlock,
        toBlock
      });
    } catch (error) {
      console.error('[Ethereum] 获取事件日志失败:', error instanceof Error ? error.message : String(error));
      // 设置空的事件日志列表，使应用能够继续运行
      logs = [];
      console.warn('[Ethereum] 使用空的事件日志列表继续执行');
    }

    if (logs.length === 0) {
      console.log("[Deposit Monitor] 未发现Transfer事件");
      // 使用统一的存储接口
      await setLastProcessedBlock(toBlock);
      return;
    }

    console.log(`[Deposit Monitor] 发现 ${logs.length} 个Transfer事件待处理`);

    let processedCount = 0;
    for (const log of logs) {
      try {
        processedCount++;
        
        // 安全访问log.args属性
        const logWithArgs = log as any;
        const args = logWithArgs.args;
        
        // 提取事件参数
        const value = args.value;
        const from = args.from as string;
        const to = args.to as `0x${string}`;
        const txHash = log.transactionHash;
        
        // 检查txHash是否有效
        if (!txHash) {
          console.error('[Transaction] 无效的交易哈希');
          continue;
        }
        
        // 转换金额为实际单位
        const amountUsdt = Number(value) / 10 ** USDT_DECIMAL;

        // 根据接收代币方地址查询用户信息
        const user = await getUserByAddress(from);
        if (!user) {
          console.error("[Deposit Monitor] 用户未找到", { from, txHash, amountUsdt });
          continue;
        }
        
        // 调用确认交易并扣减积分的函数
        try {
          await confirmTransactionAndDeductCredits(
            user.id,
            txHash,
            amountUsdt,
            TARGET_CONTRACT_ADDRESS
          );
          
          console.log("[Deposit Monitor] 存款积分已扣减", {
            txHash,
            amountUsdt,
            blockNumber: log.blockNumber
          });
        } catch (error) {
          console.error(`[Transaction] 确认交易并扣减积分失败:`, error instanceof Error ? error.message : String(error));
        }
      } catch (error) {
        console.error(`[Transaction] 处理日志 ${processedCount}/${logs.length} 失败:`, error instanceof Error ? error.message : String(error));
      }
    }
    
    // 更新最后处理的区块号
    await setLastProcessedBlock(toBlock);
    const endTime = Date.now();
    console.log(`[Deposit Monitor] 处理完成! 已处理 ${processedCount}/${logs.length} 笔存款, 更新区块高度: ${toBlock}, 耗时: ${endTime - startTime}ms`);
  } catch (error) {
    console.error("[Deposit Monitor] 主流程错误:", error instanceof Error ? error.message : String(error));
  }
}


/**
 * 根据钱包地址查询用户信息
 * @param address 用户的钱包地址
 * @returns 用户信息对象，包含id和name等字段
 */
async function getUserByAddress(address: `0x${string}`): Promise<{ id: string; name: string } | null> {
  try {
    // 连接到数据库查询用户信息
    
    // 模拟数据库查询延迟
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // 模拟用户数据库
    const mockUserDatabase: Record<string, { id: string; name: string }> = {
      '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D': { id: 'user_001', name: '信用收集者' },
      '0x1234567890123456789012345678901234567890': { id: 'user_002', name: '测试用户1' },
      '0x0987654321098765432109876543210987654321': { id: 'user_003', name: '测试用户2' },
      '0x8d802363Bf75E93c58de92e8A434390f77866d12': { id: 'user_004', name: '23188636' },
      '0xe955E61Fb93B0871953d5C55f8afd416EbaAfdA4': { id: 'user_005', name: '23188636' },

    };
    
    // 检查是否存在该地址的用户
    if (mockUserDatabase[address]) {
      console.log(`[User Service] 找到用户: ${mockUserDatabase[address].name} (${address})`);
      return mockUserDatabase[address];
    }
    
    console.warn(`[User Service] 未找到地址对应的用户: ${address}`);
    return null;
  } catch (error) {
    console.error(`[User Service] 查询用户时出错:`, error);
    return null;
  }
}

/**
 * 确认交易并扣减用户积分
 * @param userId 用户ID
 * @param txHash 交易哈希
 * @param amount 交易金额（USDT）
 * @param tokenContract 代币合约地址
 * @returns 购买的积分数量
 */
async function confirmTransactionAndDeductCredits(
  userId: string,
  txHash: `0x${string}`,
  amount: number,
  tokenContract: `0x${string}`
): Promise<number> {
  try {
    // 1. 验证用户ID参数
    if (!userId || typeof userId !== 'string' || userId.trim() === '') {
      throw new Error('无效的用户ID');
    }
    
    // 2. 确认交易状态
    const txReceipt = await publicClient.getTransactionReceipt({ hash: txHash });
    
    if (!txReceipt || !txReceipt.status) {
      throw new Error(`交易未确认或失败: ${txHash}`);
    }
    
    console.log(`[Payment Service] 交易已确认: ${txHash}, 区块号: ${txReceipt.blockNumber}`);
    
    // 3. 计算积分数量 (假设1 代币 = 100积分)
    const creditRate = 100; // 积分兑换比例
    const purchasedCredits = Math.floor(amount * creditRate);
    
    // 验证积分数量
    if (!purchasedCredits || purchasedCredits <= 0) {
      throw new Error('积分数量必须为正数');
    }
    
    // 4. 检查用户积分余额 (模拟)
    // 在实际项目中，这里应该先查询用户当前积分，验证是否足够扣减
    const userHasSufficientCredits = true; // 模拟用户有足够积分
    if (!userHasSufficientCredits) {
      throw new Error(`用户 ${userId} 积分不足，无法完成兑换`);
    }
    
    // 5. 更新用户积分数据库
    // 模拟数据库更新延迟
    await new Promise(resolve => setTimeout(resolve, 200));
    
    // 6. 记录交易日志
    console.log(`[Payment Service] 用户 ${userId} 扣减积分成功: ${purchasedCredits} 积分 (${amount} 代币)`);
    console.log(`[Credit Service] 用户 ${userId} 积分扣减成功: ${purchasedCredits} 积分`);
    
    return purchasedCredits;
  } catch (error) {
    console.error(`[Payment Service] 确认交易并扣减积分时出错:`, error instanceof Error ? error.message : String(error));
    throw error; // 重新抛出错误，让调用者处理
  }
}

// 初始化存储并启动应用
async function startApp() {
  try {
    await initializeStorage();
    // 定时执行（例如每5分钟）
    setInterval(processDeposits, 5 * 60 * 1000);
    await processDeposits(); // 立即执行一次
  } catch (error) {
    console.error("[App] 启动失败:", error instanceof Error ? error.message : String(error));
  }
}

// 启动应用
startApp();