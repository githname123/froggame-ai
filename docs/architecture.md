# FrogGame AI — Technical Architecture

## System Overview

FrogGame AI is a three-layer architecture: blockchain (X Layer) ↔ server (Node.js) ↔ client (browser).

## Game Loop

1. **New Round** — Server increments round ID, broadcasts `round-started` via WebSocket
2. **Betting Phase** — Players select food + amount, server atomically deducts balance + records bet
3. **Settlement** — Timer expires, server picks random food (frog eats it), calculates winners/losers
4. **On-Chain Settlement** — Server calls `settleRound()` on smart contract with signed data
5. **Reward Distribution** — 90% losers' pool → winners (proportional), 2% burn, 8% dev
6. **Repeat** — New round starts automatically

## AI Agent Layer

The AI agent operates as a read-only analysis layer on top of the game engine:

### Strategy Engine
- Collects real-time bet distribution from memory cache
- Computes safety scores: foods with fewer bets have higher safety
- Calculates expected value per food based on current pool distribution
- Generates recommendations with confidence levels

### History Analyzer
- Queries PostgreSQL for past round settlements
- Computes frequency distributions for frog's food selection
- Detects streaks and patterns (even though selection is random, statistical anomalies occur)
- Provides win rate data per food slot

### Risk Assessor
- Pulls player history from database
- Classifies risk profile based on win rate, bet sizing, and frequency
- Recommends bet sizes using Kelly Criterion variant
- Factors in current bankroll (via OnchainOS Wallet API)

### Natural Language Chat
- Intent classification: status / strategy / history / risk / price / help
- Keyword extraction maps to structured API calls
- Response generation with game context

## OnchainOS Integration Points

1. **Wallet Balance** — Check Agentic Wallet and player balances on X Layer
2. **DEX Token Price** — Real-time OEOE/USDT price for value display
3. **Market Data** — Volume, liquidity metrics for risk context
4. **Gas Estimation** — Factor gas costs into strategy recommendations

## Security

- Server-signed settlement prevents manipulation
- Atomic bet placement (DB transaction: deduct balance + insert bet)
- Anti-hedging: one food per player per round
- Rate limiting on write endpoints
- Session token authentication
- No private keys in client-side code
