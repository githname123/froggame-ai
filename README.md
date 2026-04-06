# FrogGame AI — AI-Powered On-Chain Gaming Agent on X Layer

> An AI strategy agent that analyzes betting patterns, provides real-time recommendations, and integrates with OKX OnchainOS for autonomous on-chain operations — all on X Layer.

**Track:** X Layer Arena | **Hackathon:** OKX Build X 2026 | **Chain:** X Layer (196)

## What is FrogGame AI?

FrogGame is a prediction game on X Layer: players bet OEOE tokens on one of 8 foods. When the timer ends, a frog eats one food randomly — bettors on the eaten food lose, everyone else wins proportionally from the losers' pool (90% rewards / 2% burn / 8% dev).

**FrogGame AI** adds an intelligent agent layer:

- 🧠 **AI Strategy Engine** — Real-time analysis of betting distributions, historical patterns, and risk assessment
- 💬 **Natural Language Advisor** — Ask the AI "What should I bet?" in plain English/Chinese
- 🔗 **OnchainOS Integration** — Wallet balance queries, OEOE price feeds, and on-chain analytics via OKX OnchainOS APIs
- 📊 **Live Analytics Dashboard** — Visualize food win rates, betting heatmaps, and player statistics

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                   Frontend (Browser)                 │
│  ┌──────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │  Game UI  │  │  AI Strategy  │  │  Chat Advisor │  │
│  │  (Bet/    │  │  Panel        │  │  (NLP Input)  │  │
│  │   Watch)  │  │  (Live Stats) │  │               │  │
│  └─────┬─────┘  └──────┬───────┘  └──────┬────────┘  │
│        │               │                 │            │
│        └───────────────┼─────────────────┘            │
│                        │ HTTP/WS                      │
└────────────────────────┼──────────────────────────────┘
                         │
┌────────────────────────┼──────────────────────────────┐
│              FrogGame AI Server (Node.js)              │
│  ┌──────────┐  ┌──────────────┐  ┌───────────────┐   │
│  │  Game     │  │  AI Agent     │  │  OnchainOS    │   │
│  │  Engine   │  │  Engine       │  │  Integration  │   │
│  │  (Rounds  │  │  (Strategy,   │  │  (Wallet,     │   │
│  │   Bets,   │  │   Risk, NLP)  │  │   DEX, Data)  │   │
│  │   Settle) │  │               │  │               │   │
│  └─────┬─────┘  └──────────────┘  └──────┬────────┘   │
│        │                                  │            │
│  ┌─────┴────────┐               ┌─────────┴────────┐  │
│  │  PostgreSQL   │               │  OnchainOS APIs  │  │
│  │  (Game Data)  │               │  (X Layer RPC)   │  │
│  └───────────────┘               └──────────────────┘  │
└────────────────────────────────────────────────────────┘
                         │
                  ┌──────┴──────┐
                  │  X Layer    │
                  │  Blockchain │
                  │  (Chain 196)│
                  └─────────────┘
```

## OnchainOS Integration

| Module | Usage | API Calls |
|--------|-------|-----------|
| **Wallet API** | Query Agentic Wallet balance, player token holdings | `GET /wallet/balance` |
| **DEX API** | Real-time OEOE token price, liquidity data | `GET /dex/token-price` |
| **Data API** | On-chain transaction analytics, market metrics | `GET /data/market` |
| **OnChain Gateway** | Gas estimation for strategy planning | `GET /gateway/gas-price` |

**Agentic Wallet:** `0x603eda776770ac92c0232f23eb66ed8f28cbd275`

## AI Features

### 1. Strategy Analysis (`GET /api/ai/strategy`)
Analyzes current round betting distribution and returns:
- Safety scores per food (less bet = safer)
- Odds and expected value per food
- AI-recommended pick with confidence level

### 2. History Analysis (`GET /api/ai/history-analysis`)
Analyzes past rounds to identify:
- Food selection frequency by the frog
- Win/loss rates per food slot
- Trend detection (hot/cold streaks)

### 3. Risk Assessment (`GET /api/ai/risk-assessment/:address`)
Player-specific analysis:
- Win rate and profit/loss history
- Suggested bet sizing based on bankroll
- Risk profile classification (conservative/moderate/aggressive)

### 4. Natural Language Chat (`POST /api/ai/chat`)
Ask anything about the game:
- "What's the safest bet right now?"
- "How much should I bet with 100 OEOE?"
- "Show me today's statistics"

## Quick Start

### Prerequisites
- Node.js 18+
- PostgreSQL 14+
- OKX OnchainOS API Key ([Get one here](https://web3.okx.com/onchainos/dev-portal))

### Installation

```bash
git clone https://github.com/githname123/froggame-ai.git
cd froggame-ai
npm install
```

### Configuration

```bash
cp .env.example .env
# Edit .env with your keys:
#   SERVER_PRIVATE_KEY=<your-server-wallet-key>
#   ONCHAINOS_API_KEY=<your-onchainos-key>
#   DATABASE_URL=<your-postgres-url>
#   GAME_CONTRACT_ADDRESS=<deployed-contract>
#   OEOE_TOKEN=<token-address>
```

### Run

```bash
npm start
# Server starts at http://localhost:3001
# Open browser to play + see AI panel
```

## Smart Contract

`FrogGameV2.sol` — Deployed on X Layer (Chain ID 196)

- ERC-20 deposit/withdraw (OEOE token, 9 decimals)
- Server-signed round settlement
- 90/2/8 reward split (winners/burn/dev)
- Pausable + ReentrancyGuard security

## Tech Stack

- **Backend:** Node.js, Express, WebSocket, ethers.js
- **Frontend:** Vanilla JS, CSS Grid, WebSocket real-time updates
- **Database:** PostgreSQL
- **Blockchain:** X Layer (EVM), Solidity 0.8.20
- **AI:** Statistical analysis engine, pattern recognition, NLP intent parser
- **APIs:** OKX OnchainOS (Wallet, DEX, Data, Gateway)

## Project Structure

```
froggame-ai/
├── README.md
├── package.json
├── .env.example
├── server/
│   ├── index.js          # Main game server
│   ├── ai-agent.js       # AI strategy engine
│   └── onchainos.js      # OnchainOS API integration
├── public/
│   ├── index.html         # Game UI + AI panels
│   └── ai-panel.js        # AI panel client logic
├── contracts/
│   └── FrogGameV2.sol     # Smart contract
└── docs/
    └── architecture.md    # Technical architecture
```

## License

MIT

## Links

- **Live Demo:** [Coming soon]
- **Contract:** [X Layer Explorer](https://www.oklink.com/xlayer)
- **Hackathon:** [m/buildx on Moltbook](https://www.moltbook.com/m/buildx)
