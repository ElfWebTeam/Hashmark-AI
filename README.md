# Hashmark AI

**Hashmark AI** is an AI-powered document notary built on the Hedera network.  
It lets anyone upload a file, pay per notarization in HBAR, and get a permanent, verifiable proof of existence.  
Each notarization is summarized by AI, recorded to Hedera File Service (HFS), and minted as a 1-of-1 NFT on Hedera Token Service (HTS).  
All notarizations and agent-generated attestations stream in real time over Hedera Consensus Service (HCS).

Live demo: [https://hashmark-ai.onrender.com](https://hashmark-ai.onrender.com)  
Built for the **Hello Future: Origins** hackathon (Track: AI & Agents)

---

## ✨ Features

- **Pay-per-use notarization** in HBAR via MetaMask on Hedera testnet
- **Local file hashing** (SHA-256) before upload
- **AI-generated summary** for each document (OpenAI API)
- **Immutable proof**: metadata stored on HFS with no update keys
- **On-chain NFT marker**: 1-of-1 HTS token per notarization
- **Live HCS feed**: notarizations + attestations appear in real time
- **Automated agent attestations**: subscriber reacts to new HCS events, runs checks, signs results, and stores them back to HFS
- **Duplicate detection**: skips payment if the file was already notarized
- **Verification tool**: upload any file to check for a match and view its proofs

---

## How It Works

1. **Upload a file** (PDF, DOCX, or image).
2. Client hashes the file locally and checks with the server if it’s already in the registry.
3. If new, MetaMask prompts for an HBAR payment to the treasury address.
4. Server verifies the payment on-chain, re-hashes the uploaded file, and generates an AI summary + deterministic field extraction.
5. Metadata (hash, filename, summary, extracted fields, timestamp) is stored immutably in HFS.
6. A 1-of-1 HTS NFT is minted with metadata pointing to the HFS file.
7. Server publishes a `hedger.notarized` event to HCS.
8. Agent subscriber picks up the event, runs extra checks, signs an attestation, stores it to HFS, and publishes a `hedger.attested` event.
9. Both notarizations and attestations stream live to the frontend.
10. Anyone can verify a file by re-hashing and looking up its records.

---

## 🛠 Tech Stack

| Layer         | Tech Used |
|---------------|-----------|
| Blockchain    | Hedera HCS + HFS + HTS |
| Wallet        | MetaMask (Hedera testnet via EVM) |
| Backend       | Node.js + Express |
| Frontend      | HTML + CSS + JS |
| AI            | OpenAI API (text summarization) |
| Storage       | HFS (immutable proofs) + JSON file (local state) |

---

## Local Development

Clone and run locally:

```bash
git clone https://github.com/ElfWebTeam/Hashmark-AI.git
cd Hashmark-AI
npm install
npm start

Then open: http://localhost:3000

Requirements:

Node.js 18+

MetaMask wallet connected to Hedera Testnet (chainId 0x128)

Testnet HBAR in your wallet

.env file with:
HEDERA_OPERATOR_ID=0.0.xxxxxx
HEDERA_OPERATOR_KEY=302e0201...
OPENAI_API_KEY=sk-...
TREASURY_ADDRESS=0x...
PRICE_WEI=500000000000000000
HASHIO_RPC_URL=https://testnet.hashio.io/api
MAX_FILE_MB=12
PORT=3000
```

### Verification Flow
-Go to the Verify section.
-Upload any file.
-The app hashes the file and checks if it matches an existing notarization.
-If matched, shows:
-Original HFS file ID
-HTS token ID
-Any agent-generated attestations (HFS file IDs and timestamps)

###About the Hackathon
-Event: Hello Future: Origins (DoraHacks)
-Track: AI and Agents
-Focus: AI-blockchain integration, autonomous agents, verifiable proofs
