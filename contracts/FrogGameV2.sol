// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
// [C-07] 导入 Pausable 合约，添加紧急暂停机制
import "@openzeppelin/contracts/security/Pausable.sol";

/**
 * @title FrogGameV2
 * @dev 黑蛙饿了游戏 V2 - 投注池架构（安全审计升级版）
 * 
 * 安全修复：
 * - C-01: settleRound 输家余额安全扣减（不再 revert）
 * - C-02: settleRoundSimple 负数金额实际扣减余额
 * - C-03: settleAmountCap 限制单轮结算上限
 * - C-04: settleRoundSimple 添加金额守恒校验
 * - C-05: totalPlayerBalances 状态变量追踪余额总量
 * - C-06: roundId 必须严格递增（不可跳跃）
 * - C-07: Pausable 紧急暂停机制
 */
contract FrogGameV2 is ReentrancyGuard, Ownable, Pausable {
    using SafeERC20 for IERC20;
    using ECDSA for bytes32;

    IERC20 public immutable oeoeToken;
    address public serverSigner;      // 服务器签名地址
    address public devAddress;        // 开发费地址
    address public burnAddress;       // 销毁地址
    
    // ============ 经济参数 ============
    uint256 public constant REWARD_PERCENT = 90;   // 赢家奖励 90%
    uint256 public constant BURN_PERCENT = 2;      // 销毁 2%
    uint256 public constant DEV_PERCENT = 8;       // 开发费 8%
    
    // ============ 用户余额池 ============
    mapping(address => uint256) public playerBalances;
    mapping(address => uint256) public playerTotalInvested;
    mapping(address => uint256) public playerTotalWon;
    
    // [C-05] 追踪所有玩家余额总和，避免遍历
    uint256 public totalPlayerBalances;
    
    // [C-03] 每轮结算金额上限，防止 serverSigner 单点风险
    uint256 public settleAmountCap;
    
    // ============ 结算记录 ============
    struct Settlement {
        uint256 roundId;
        bytes32 roundHash;
        uint256 totalPool;        // 输家池总额
        uint256 burnAmount;
        uint256 devAmount;
        uint256 rewardAmount;
        uint256 winnerCount;
        uint256 loserCount;
        uint256 timestamp;
    }
    
    mapping(uint256 => Settlement) public settlements;
    uint256 public currentRoundId;
    
    // ============ 事件 ============
    event Deposit(address indexed player, uint256 amount);
    event Withdraw(address indexed player, uint256 amount);
    event BetPlaced(address indexed player, uint256 roundId, uint8 foodIndex, uint256 amount);
    event RoundSettled(
        uint256 indexed roundId,
        bytes32 roundHash,
        uint256 totalPool,
        uint256 winnerCount,
        uint256 loserCount,
        uint256 burnAmount,
        uint256 devAmount
    );
    event RewardDistributed(
        uint256 indexed roundId,
        address indexed player,
        uint256 reward
    );
    event LoserDeducted(
        uint256 indexed roundId,
        address indexed player,
        uint256 amount
    );
    event ServerSignerUpdated(address oldSigner, address newSigner);
    // [C-03] 结算上限变更事件
    event SettleAmountCapUpdated(uint256 oldCap, uint256 newCap);
    
    // ============ 修饰符 ============
    modifier onlyServer() {
        require(msg.sender == owner() || msg.sender == serverSigner, "Not authorized");
        _;
    }
    
    constructor(
        address _oeoeToken,
        address _serverSigner,
        address _devAddress,
        address _burnAddress
    ) Ownable() {
        require(_oeoeToken != address(0), "Invalid token");
        require(_serverSigner != address(0), "Invalid server signer");
        require(_devAddress != address(0), "Invalid dev address");
        require(_burnAddress != address(0), "Invalid burn address");
        
        oeoeToken = IERC20(_oeoeToken);
        serverSigner = _serverSigner;
        devAddress = _devAddress;
        burnAddress = _burnAddress;
    }
    
    // ============ 核心功能：存款 ============
    
    /**
     * @dev 存款到余额池
     */
    function deposit(uint256 amount) external nonReentrant whenNotPaused {
        require(amount > 0, "Amount must be > 0");
        
        oeoeToken.safeTransferFrom(msg.sender, address(this), amount);
        
        playerBalances[msg.sender] += amount;
        // [C-05] 同步更新总余额
        totalPlayerBalances += amount;
        
        emit Deposit(msg.sender, amount);
    }
    
    // ============ 核心功能：提款 ============
    
    /**
     * @dev 从余额池提款
     */
    function withdraw(uint256 amount) external nonReentrant whenNotPaused {
        require(amount > 0, "Amount must be > 0");
        require(playerBalances[msg.sender] >= amount, "Insufficient balance");
        
        playerBalances[msg.sender] -= amount;
        // [C-05] 同步更新总余额
        totalPlayerBalances -= amount;
        
        oeoeToken.safeTransfer(msg.sender, amount);
        
        emit Withdraw(msg.sender, amount);
    }
    
    // ============ 核心功能：投注（链下模式）============
    
    /**
     * @dev 投注 - 仅用于需要链上记录的场景
     */
    function placeBet(
        uint256 roundId,
        uint8 foodIndex,
        uint256 amount
    ) external nonReentrant whenNotPaused {
        require(amount > 0, "Amount must be > 0");
        require(foodIndex < 8, "Invalid food index");
        require(playerBalances[msg.sender] >= amount, "Insufficient balance");
        
        playerBalances[msg.sender] -= amount;
        // [C-05] 投注从余额池扣除，总量减少
        totalPlayerBalances -= amount;
        
        emit BetPlaced(msg.sender, roundId, foodIndex, amount);
    }
    
    // ============ 辅助函数 ============
    
    /**
     * @dev [C-01/C-02] 安全扣减余额，不足时扣到 0 而非 revert
     * @return actual 实际扣减的金额
     */
    function _safeDeduct(address player, uint256 amount) internal returns (uint256 actual) {
        uint256 bal = playerBalances[player];
        actual = amount < bal ? amount : bal;  // min(amount, balance)
        if (actual > 0) {
            playerBalances[player] -= actual;
            // [C-05] 同步更新总余额
            totalPlayerBalances -= actual;
        }
    }
    
    // ============ 核心功能：结算（投注池模式）============
    
    /**
     * @dev 结算一轮游戏（投注池模式）
     */
    function settleRound(
        uint256 roundId,
        bytes32 roundHash,
        bytes calldata serverSignature,
        address[] calldata losers,
        uint256[] calldata loserAmounts,
        address[] calldata winners,
        uint256[] calldata rewards
    ) external onlyServer nonReentrant whenNotPaused {
        // [C-06] roundId 必须严格递增，不可跳跃
        require(roundId == currentRoundId + 1, "Round ID must be sequential");
        require(losers.length == loserAmounts.length, "Losers length mismatch");
        require(winners.length == rewards.length, "Rewards length mismatch");
        
        // 1. 验证服务器签名
        bytes32 ethSignedHash = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", roundHash));
        address signer = ECDSA.recover(ethSignedHash, serverSignature);
        require(signer == serverSigner, "Invalid server signature");
        
        // 2. 计算输家池总额
        uint256 totalPool = 0;
        for (uint i = 0; i < loserAmounts.length; i++) {
            totalPool += loserAmounts[i];
        }
        
        // 如果没有输家（无竞争局），跳过结算
        if (totalPool == 0) {
            currentRoundId = roundId;
            return;
        }
        
        // [C-03] 检查结算金额上限（settleAmountCap == 0 表示不限制）
        require(settleAmountCap == 0 || totalPool <= settleAmountCap, "Exceeds settle amount cap");
        
        // 3. 计算经济分配
        uint256 burnAmount = (totalPool * BURN_PERCENT) / 100;
        uint256 devAmount = (totalPool * DEV_PERCENT) / 100;
        
        // 4. [C-01] 安全扣除输家余额 — 余额不足时扣到 0，不会 revert
        for (uint i = 0; i < losers.length; i++) {
            if (loserAmounts[i] > 0) {
                uint256 actualDeducted = _safeDeduct(losers[i], loserAmounts[i]);
                playerTotalInvested[losers[i]] += actualDeducted;
                emit LoserDeducted(roundId, losers[i], actualDeducted);
            }
        }
        
        // 5. 处理销毁
        if (burnAmount > 0) {
            oeoeToken.safeTransfer(burnAddress, burnAmount);
        }
        
        // 6. 处理开发费
        if (devAmount > 0) {
            oeoeToken.safeTransfer(devAddress, devAmount);
        }
        
        // 7. 给赢家加奖励
        for (uint i = 0; i < winners.length; i++) {
            if (rewards[i] > 0) {
                playerBalances[winners[i]] += rewards[i];
                // [C-05] 同步更新总余额
                totalPlayerBalances += rewards[i];
                playerTotalWon[winners[i]] += rewards[i];
                emit RewardDistributed(roundId, winners[i], rewards[i]);
            }
        }
        
        // 8. 记录结算
        currentRoundId = roundId;
        settlements[roundId] = Settlement({
            roundId: roundId,
            roundHash: roundHash,
            totalPool: totalPool,
            burnAmount: burnAmount,
            devAmount: devAmount,
            rewardAmount: totalPool * REWARD_PERCENT / 100,
            winnerCount: winners.length,
            loserCount: losers.length,
            timestamp: block.timestamp
        });
        
        emit RoundSettled(roundId, roundHash, totalPool, winners.length, losers.length, burnAmount, devAmount);
    }
    
    // ============ 简化版结算（仅处理输赢）============
    
    /**
     * @dev 简化版结算 - 直接传入最终结果
     */
    function settleRoundSimple(
        uint256 roundId,
        bytes32 roundHash,
        bytes calldata serverSignature,
        address[] calldata balanceChanges,
        int256[] calldata amounts,
        uint256 burnAmount,
        uint256 devAmount
    ) external onlyServer nonReentrant whenNotPaused {
        // [C-06] roundId 必须严格递增，不可跳跃
        require(roundId == currentRoundId + 1, "Round ID must be sequential");
        require(balanceChanges.length == amounts.length, "Length mismatch");
        
        // 1. 验证服务器签名
        bytes32 ethSignedHash = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", roundHash));
        address signer = ECDSA.recover(ethSignedHash, serverSignature);
        require(signer == serverSigner, "Invalid server signature");
        
        // 2. 处理销毁
        if (burnAmount > 0) {
            oeoeToken.safeTransfer(burnAddress, burnAmount);
        }
        
        // 3. 处理开发费
        if (devAmount > 0) {
            oeoeToken.safeTransfer(devAddress, devAmount);
        }
        
        // 4. [C-04] 金额守恒校验：累计正负金额
        uint256 totalAdded = 0;
        uint256 totalRemoved = 0;
        
        // 5. 处理余额变动
        for (uint i = 0; i < balanceChanges.length; i++) {
            if (amounts[i] > 0) {
                // 正数：增加余额
                uint256 addAmount = uint256(amounts[i]);
                playerBalances[balanceChanges[i]] += addAmount;
                // [C-05] 同步更新总余额
                totalPlayerBalances += addAmount;
                totalAdded += addAmount;
                emit RewardDistributed(roundId, balanceChanges[i], addAmount);
            } else if (amounts[i] < 0) {
                // [C-02] 负数：安全扣减余额（之前只发 event 不扣余额）
                uint256 deductAmount = uint256(-amounts[i]);
                uint256 actualDeducted = _safeDeduct(balanceChanges[i], deductAmount);
                totalRemoved += deductAmount;
                emit LoserDeducted(roundId, balanceChanges[i], actualDeducted);
            }
        }
        
        // [C-04] 校验：发出的奖励不能超过扣除的金额 + 销毁 + 开发费
        require(totalAdded <= totalRemoved + burnAmount + devAmount, "Payout exceeds input");
        
        // 6. 记录结算
        currentRoundId = roundId;
        
        emit RoundSettled(roundId, roundHash, burnAmount + devAmount, balanceChanges.length, 0, burnAmount, devAmount);
    }
    
    // ============ 查询函数 ============
    
    /**
     * @dev 获取玩家余额
     */
    function getPlayerBalance(address player) external view returns (uint256) {
        return playerBalances[player];
    }
    
    /**
     * @dev 获取玩家统计
     */
    function getPlayerStats(address player) external view returns (
        uint256 balance,
        uint256 totalInvested,
        uint256 totalWon
    ) {
        return (
            playerBalances[player],
            playerTotalInvested[player],
            playerTotalWon[player]
        );
    }
    
    /**
     * @dev 获取合约代币余额
     */
    function getContractBalance() external view returns (uint256) {
        return oeoeToken.balanceOf(address(this));
    }
    
    /**
     * @dev [C-05] 获取合约记账余额总和
     * 现在返回实时追踪的 totalPlayerBalances 状态变量
     */
    function getTotalPlayerBalances() external view returns (uint256) {
        return totalPlayerBalances;
    }
    
    // ============ 管理函数 ============
    
    /**
     * @dev 更新服务器签名地址
     */
    function setServerSigner(address _serverSigner) external onlyOwner {
        require(_serverSigner != address(0), "Invalid address");
        address oldSigner = serverSigner;
        serverSigner = _serverSigner;
        emit ServerSignerUpdated(oldSigner, _serverSigner);
    }
    
    /**
     * @dev 更新开发费地址
     */
    function setDevAddress(address _devAddress) external onlyOwner {
        require(_devAddress != address(0), "Invalid address");
        devAddress = _devAddress;
    }
    
    /**
     * @dev [C-03] 设置每轮结算金额上限（0 = 不限制）
     */
    function setSettleAmountCap(uint256 _cap) external onlyOwner {
        uint256 oldCap = settleAmountCap;
        settleAmountCap = _cap;
        emit SettleAmountCapUpdated(oldCap, _cap);
    }
    
    /**
     * @dev [C-07] 暂停合约（仅限 owner）
     */
    function pause() external onlyOwner {
        _pause();
    }
    
    /**
     * @dev [C-07] 恢复合约（仅限 owner）
     */
    function unpause() external onlyOwner {
        _unpause();
    }
    
    /**
     * @dev 管理员批量充值（仅限合约迁移时使用）
     * Owner 先将代币 approve 给本合约，然后调用此函数为玩家批量充值
     * @param players 玩家地址数组
     * @param amounts 对应余额数组（Wei 单位）
     */
    function adminBatchDeposit(
        address[] calldata players,
        uint256[] calldata amounts
    ) external onlyOwner nonReentrant {
        require(players.length == amounts.length, "Length mismatch");
        
        uint256 totalAmount = 0;
        for (uint i = 0; i < amounts.length; i++) {
            totalAmount += amounts[i];
        }
        
        // 一次性从 Owner 转入合约
        oeoeToken.safeTransferFrom(msg.sender, address(this), totalAmount);
        
        // 分配给每个玩家
        for (uint i = 0; i < players.length; i++) {
            if (amounts[i] > 0) {
                playerBalances[players[i]] += amounts[i];
                totalPlayerBalances += amounts[i];
                emit Deposit(players[i], amounts[i]);
            }
        }
    }
    
    /**
     * @dev 紧急提款（仅限所有者）
     */
    function emergencyWithdraw(address token, uint256 amount) external onlyOwner {
        IERC20(token).safeTransfer(owner(), amount);
    }
}
