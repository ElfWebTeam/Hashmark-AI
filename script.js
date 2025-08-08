// ===== Hedger – client script (HBAR payments + duplicate pre-check + live HCS feed) =====
let userAccount = null;
let TREASURY_ADDRESS = '';
let PRICE_WEI = '0';
let HCS_TOPIC_ID = null;

const { ethers } = window;

/* ----------------- helpers ----------------- */
const $ = (s) => document.querySelector(s);
function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}
function setText(el, text) { if (!el) return; el.textContent = text || ''; }
function setHtmlSafe(el, text) { if (!el) return; el.textContent = text || ''; } // no innerHTML for model output

async function loadPublicConfig() {
  const r = await fetch('/config'); const j = await r.json();
  TREASURY_ADDRESS = j.treasury; PRICE_WEI = j.priceWei; HCS_TOPIC_ID = j.hcsTopicId || null;
  const priceHBAR = ethers.utils.formatEther(PRICE_WEI);
  setText($('#priceBanner'), `${priceHBAR} HBAR per notarization`);
  if (HCS_TOPIC_ID) setText($('#hcsTopic'), `HCS Topic: ${HCS_TOPIC_ID}`);
}

/* ----------------- wallet ------------------ */
async function connectWallet() {
  if (!window.ethereum) { toast('MetaMask not found'); return; }
  const provider = new ethers.providers.Web3Provider(window.ethereum);
  await provider.send('wallet_addEthereumChain', [{
    chainId: '0x128', chainName: 'Hedera Testnet', rpcUrls: ['https://testnet.hashio.io/api'],
    nativeCurrency: { name: 'HBAR', symbol: 'HBAR', decimals: 18 }
  }]).catch(()=>{});
  await provider.send('eth_requestAccounts', []);
  const signer = provider.getSigner();
  userAccount = (await signer.getAddress()).toLowerCase();
  setText($('#account'), userAccount);
}

/* --------------- notarize ------------------ */
async function notarizeDocument() {
  const f = $('#docInput').files?.[0];
  if (!f) { toast('Choose a file'); return; }

  // pre-hash client-side
  const content = await f.arrayBuffer();
  const hashBuf = await crypto.subtle.digest('SHA-256', content);
  const clientHashHex = '0x' + [...new Uint8Array(hashBuf)].map(b=>b.toString(16).padStart(2,'0')).join('');
  const check = await (await fetch(`/api/check/${clientHashHex.replace(/^0x/,'')}`)).json();
  const isDup = !!check.exists;

  let txHash = '';
  if (!isDup) {
    if (!userAccount) await connectWallet();
    const provider = new ethers.providers.Web3Provider(window.ethereum);
    const signer = provider.getSigner();
    const tx = await signer.sendTransaction({ to: TREASURY_ADDRESS, value: PRICE_WEI });
    await tx.wait(1);
    txHash = tx.hash;
  }

  const fd = new FormData();
  fd.append('doc', f);
  fd.append('walletAddress', userAccount || '');
  fd.append('clientHashHex', clientHashHex);
  if (txHash) fd.append('txHash', txHash);

  const r = await fetch('/api/notarize', { method: 'POST', body: fd });
  const j = await r.json();
  if (!j.success) { toast(j.error || 'Failed'); return; }

  setText($('#resultHash'), j.hash);
  setText($('#resultFileId'), j.fileId);
  setText($('#resultTokenId'), j.tokenId);
  setHtmlSafe($('#resultSummary'), j.summary || '');
}

/* ---------------- verify ------------------- */
async function verifyDocument() {
  const f = $('#verifyInput').files?.[0];
  if (!f) { toast('Choose a file'); return; }
  const fd = new FormData(); fd.append('doc', f);
  const r = await fetch('/api/verify', { method: 'POST', body: fd });
  const j = await r.json();
  setText($('#verifyHash'), j.hash);
  if (j.matched) {
    setText($('#verifyStatus'), 'MATCH');
    setText($('#verifyFileId'), j.fileId);
    setText($('#verifyTokenId'), j.tokenId);
    const list = $('#attestations'); list.innerHTML = '';
    (j.attestations || []).forEach(a => {
      const li = document.createElement('li');
      li.textContent = `${a.fileId} @ ${new Date(a.timestamp).toISOString()}`;
      list.appendChild(li);
    });
  } else {
    setText($('#verifyStatus'), 'NO MATCH');
    $('#attestations').innerHTML = '';
    setText($('#verifyFileId'), '');
    setText($('#verifyTokenId'), '');
  }
}

/* --------------- live events --------------- */
function startEvents() {
  const es = new EventSource('/events');
  const list = $('#live');
  es.onmessage = (e) => {
    try {
      const j = JSON.parse(e.data);
      const li = document.createElement('li');
      if (j.type === 'hedger.notarized') {
        li.textContent = `HCS notarized ${j.hash} -> file ${j.fileId} token ${j.tokenId}`;
      } else if (j.type === 'hedger.attested') {
        li.textContent = `HCS attested ${j.hash} -> att ${j.attestationFileId}`;
      } else if (j.type === 'notarized') {
        li.textContent = `Server notarized ${j.hash}`;
      } else if (j.type === 'duplicate') {
        li.textContent = `Duplicate ${j.hash}`;
      } else if (j.type === 'hello') {
        if (j.hcsTopicId) setText($('#hcsTopic'), `HCS Topic: ${j.hcsTopicId}`);
        return;
      } else {
        li.textContent = JSON.stringify(j);
      }
      list.prepend(li);
      while (list.children.length > 50) list.removeChild(list.lastChild);
    } catch {}
  };
}

/* ---------------- boot --------------------- */
document.addEventListener('DOMContentLoaded', async () => {
  await loadPublicConfig();
  $('#connectBtn')?.addEventListener('click', connectWallet);
  $('#notarizeBtn')?.addEventListener('click', notarizeDocument);
  $('#verifyBtn')?.addEventListener('click', verifyDocument);
  startEvents();
});
