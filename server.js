/* ------------------------------------------------------------------
   Hedger – AI Document Notary & Verifier
   server.js  (2025-08-07 hot-fix: balance query + HCS delay)
-------------------------------------------------------------------*/
require('dotenv').config();
const path  = require('path');
const fs    = require('fs');
const crypto= require('crypto');
const express = require('express');
const bodyParser = require('body-parser');
const cors  = require('cors');
const multer= require('multer');
const chokidar = require('chokidar');
const pdfParse  = require('pdf-parse');
const { ethers } = require('ethers');

const {
  Client, AccountId, PrivateKey,
  FileCreateTransaction, FileAppendTransaction, FileUpdateTransaction, FileContentsQuery,
  TopicCreateTransaction, TopicMessageSubmitTransaction, TopicMessageQuery,
  TokenCreateTransaction, TokenMintTransaction, TokenUpdateTransaction,
  TokenType, TokenSupplyType,
  AccountBalanceQuery
} = require('@hashgraph/sdk');


const OpenAI = require('openai');
const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

/* ---------- ENV ---------- */
const operatorId  = AccountId.fromString(process.env.HEDERA_OPERATOR_ID);
const operatorKey = PrivateKey.fromString(process.env.HEDERA_OPERATOR_KEY);
const hedera       = Client.forTestnet().setOperator(operatorId, operatorKey);

const TREASURY_ADDR = (process.env.TREASURY_ADDRESS || '').toLowerCase();
const PRICE_WEI     = ethers.BigNumber.from(process.env.PRICE_WEI || 0);
const HASHIO_RPC    = process.env.HASHIO_RPC_URL || 'https://testnet.hashio.io/api';
const MAX_FILE_MB   = Number(process.env.MAX_FILE_MB || 12);

/* ---------- Express ---------- */
const app = express();
app.use(cors());
app.use(bodyParser.json({limit:'512kb'}));

const upload = multer({ storage:multer.memoryStorage(), limits:{ fileSize:MAX_FILE_MB*1024*1024 }});

/* ---------- DB ---------- */
const DB_PATH = path.join(process.cwd(),'db.json');
let DB = {};
if (fs.existsSync(DB_PATH)) {
  try { DB = JSON.parse(fs.readFileSync(DB_PATH,'utf8')); } catch {}
}
DB.files        = DB.files        || {};
DB.usedTx       = DB.usedTx       || {};
DB.pending      = DB.pending      || {};
DB.attestations = DB.attestations || {};
for (const k of Object.keys(DB)) {
  if (/^[0-9a-f]{64}$/.test(k) && !DB.files[k]) { DB.files[k]=DB[k]; delete DB[k]; }
}
const saveDB = ()=>fs.writeFileSync(DB_PATH, JSON.stringify(DB,null,2));

/* ---------- Utils ---------- */
const sha256 = (b)=>crypto.createHash('sha256').update(b).digest('hex');

async function extractText(buf,name){
  if(name.toLowerCase().endsWith('.pdf')){
    try { return (await pdfParse(buf)).text || ''; } catch{}
  }
  return buf.toString('utf8').slice(0,20000);
}
function extractDeterministic(t){
  const amounts=[...t.matchAll(/\b(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2}))\b/g)].slice(0,5).map(m=>m[1]);
  const dates  =[...t.matchAll(/\b(20\d{2}[-/](?:0?[1-9]|1[0-2])[-/](?:0?[1-9]|[12]\d|3[01]))\b/g)].slice(0,5).map(m=>m[1]);
  const ibans  =[...t.matchAll(/\b([A-Z]{2}\d{2}[A-Z0-9]{11,30})\b/g)].slice(0,3).map(m=>m[1]);
  return {amounts,dates,ibans};
}
async function summarize(t){
  if(!openai) return '';
  try{
    const r=await openai.chat.completions.create({
      model:'gpt-4o-mini',
      messages:[{role:'user',content:`Summarize in <=5 bullet points:\n\n${t.slice(0,6000)}`}],
      temperature:0.2,max_tokens:220
    });
    return r.choices?.[0]?.message?.content?.trim()||'';
  }catch{return '';}
}

/* ------------------------------------------------------------------
   Write JSON to HFS immutably, SDK v2.48+
   - step 1: create file with operator key so we can append
   - step 2: append remainder if needed
   - step 3: remove all keys → file becomes immutable
-------------------------------------------------------------------*/
async function writeImmutableHfs(json) {
  const bytes = Buffer.from(JSON.stringify(json, null, 2));

  /* step-1 create (first 4 KB) with a key */
  const createTx = await new FileCreateTransaction()
    .setKeys([operatorKey.publicKey])
    .setContents(bytes.slice(0, 4096))
    .freezeWith(hedera)
    .sign(operatorKey);                        // async

  const fileId = (await (await createTx.execute(hedera)).getReceipt(hedera))
                   .fileId.toString();

  /* step-2 append remainder (if any) */
  if (bytes.length > 4096) {
    const appendTx = await new FileAppendTransaction()
      .setFileId(fileId)
      .setContents(bytes.slice(4096))
      .freezeWith(hedera)
      .sign(operatorKey);                      // async
    await appendTx.execute(hedera);
  }

  /* step-3 strip keys so the file is now immutable */
  const stripTx = await new FileUpdateTransaction()
    .setFileId(fileId)
    .setKeys([])                               // remove all keys
    .freezeWith(hedera)
    .sign(operatorKey);                        // async
  await stripTx.execute(hedera);

  return fileId;
}


/* ------------------------------------------------------------------
   Mint 1-of-1 proof NFT – SDK v2.48+ (sign() is async)
-------------------------------------------------------------------*/
async function mintProofNft(metadataString) {
  /* 1. create collection (maxSupply = 1; no admin keys) */
  const createTx = await new TokenCreateTransaction()
    .setTokenName('Hedger Proof')
    .setTokenSymbol('HDR1')
    .setTokenType(TokenType.NonFungibleUnique)
    .setSupplyType(TokenSupplyType.Finite)
    .setMaxSupply(1)
    .setTreasuryAccountId(operatorId)
    .setSupplyKey(operatorKey.publicKey)          // needed once, to mint
    .freezeWith(hedera)
    .sign(operatorKey);                           // ← async now

  const createRec = await (await createTx.execute(hedera)).getReceipt(hedera);
  const tokenId   = createRec.tokenId.toString();

  /* 2. mint single NFT with metadata = HFS fileId */
  const mintTx = await new TokenMintTransaction()
    .setTokenId(tokenId)
    .setMetadata([Buffer.from(metadataString)])
    .freezeWith(hedera)
    .sign(operatorKey);                           // ← async

  await mintTx.execute(hedera);
  return tokenId;
}


/* --- Hashio polling --- */
async function waitReceipt(provider,hash,tries=12,delay=2500){
  for(let i=0;i<tries;i++){
    const rc=await provider.getTransactionReceipt(hash);
    if(rc) return rc;
    await new Promise(r=>setTimeout(r,delay));
  } return null;
}
async function verifyHBARPayment({txHash,from,to,minValueWei}){
  const prov=new ethers.providers.JsonRpcProvider(HASHIO_RPC);
  const rc=await waitReceipt(prov,txHash);
  if(!rc || rc.status!==1) return false;
  const tx=await prov.getTransaction(txHash);
  if(!tx) return false;
  const okTo  =(tx.to||'').toLowerCase()===to.toLowerCase();
  const okFrom=(tx.from||'').toLowerCase()===from.toLowerCase();
  const okVal =ethers.BigNumber.from(tx.value||0).gte(minValueWei);
  return okTo && okFrom && okVal;
}

/* ---------- SSE clients ---------- */
const clients=new Set();
const send=(o)=>clients.forEach(res=>res.write(`data: ${JSON.stringify(o)}\n\n`));

/* ---------- HCS ---------- */
let HCS_TOPIC_ID=(process.env.HEDGER_HCS_TOPIC_ID||'').trim();
async function ensureTopic(){
  if(HCS_TOPIC_ID) return HCS_TOPIC_ID;
  const tx=await new TopicCreateTransaction().setTopicMemo('Hedger Notarizations')
    .freezeWith(hedera).sign(operatorKey);
  const sub=await tx.execute(hedera);
  const rec=await sub.getReceipt(hedera);
  HCS_TOPIC_ID=rec.topicId.toString();
  console.log('Created HCS topic',HCS_TOPIC_ID);
  return HCS_TOPIC_ID;
}
/* ------------------------------------------------------------------
   Publish JSON message to HCS topic – SDK v2.48+ fix
-------------------------------------------------------------------*/
async function publishHcs(type, payload) {
  const id = await ensureTopic();

  const tx = await new TopicMessageSubmitTransaction()
    .setTopicId(id)
    .setMessage(Buffer.from(JSON.stringify({ type, ...payload })))
    .freezeWith(hedera);

  const signed = await tx.sign(operatorKey);   // sign() → Promise<Transaction>
  await signed.execute(hedera);                // now safe to execute

  send({ source: 'hcs-local', type, ...payload });
}


/* ---------- Public config ---------- */
app.get('/config',(req,res)=>{
  res.json({treasury:TREASURY_ADDR,priceWei:PRICE_WEI.toString(),hcsTopicId:HCS_TOPIC_ID||null});
});

/* ---------- Pre-check ---------- */
app.get('/api/check/:hash',(req,res)=>{
  const h=req.params.hash.toLowerCase().replace(/^0x/,'');
  res.json({exists:!!DB.files[h]});
});

/* ---------- Notarize ---------- */
app.post('/api/notarize',upload.single('doc'),async (req,res)=>{
  let serverHash=''; const t0=Date.now();
  try{
    const wallet=String(req.body.walletAddress||'').toLowerCase();
    const txHash=String(req.body.txHash||'');
    const buf=req.file?.buffer; const fname=req.file?.originalname||'document';
    if(!buf) return res.status(400).json({success:false,error:'No file'});

    serverHash=sha256(buf); const hashHex='0x'+serverHash;
    console.log(`[notarize] ${fname} from ${wallet} ${txHash||'(dup)'}`);

    if(DB.files[serverHash]){
      const hit=DB.files[serverHash];
      send({type:'duplicate',hash:hashHex,timestamp:Date.now()});
      return res.json({success:true,duplicate:true,hash:hashHex,...hit});
    }

    if(DB.pending[serverHash]) return res.status(409).json({success:false,error:'In progress'});
    DB.pending[serverHash]=true; saveDB();

    if(!txHash) throw new Error('Payment txHash missing');
    if(DB.usedTx[txHash]) throw new Error('TxHash already consumed');
    const paid=await verifyHBARPayment({txHash,from:wallet,to:TREASURY_ADDR,minValueWei:PRICE_WEI});
    if(!paid) throw new Error('Payment txn invalid');

    const bal=await new AccountBalanceQuery().setAccountId(operatorId).execute(hedera);
    if(bal.hbars.toTinybars().toNumber()<3_000_000_000)
      throw new Error(`Operator balance low (${bal.hbars.toString()})`);

    const text=await extractText(buf,fname);
    const fields=extractDeterministic(text);
    const summary=await summarize(text);

    const meta={kind:'hedger.notarization',hash:hashHex,filename:fname,wallet,txHash,
                timestamp:Date.now(),summary,deterministic:fields,textSnippet:text.slice(0,5000)};
    const fileId=await writeImmutableHfs(meta);

    const tokenId=await mintProofNft(JSON.stringify({fileId}));

    DB.files[serverHash]={fileId,tokenId,summary,timestamp:meta.timestamp,filename:fname,txHash,wallet};
    DB.usedTx[txHash]={by:wallet,at:Date.now()}; saveDB();

    await publishHcs('hedger.notarized',{hash:hashHex,fileId,tokenId,timestamp:meta.timestamp});
    send({type:'notarized',hash:hashHex,fileId,tokenId,timestamp:meta.timestamp});

    res.json({success:true,duplicate:false,hash:hashHex,fileId,tokenId,summary,timestamp:meta.timestamp,ms:Date.now()-t0});
  }catch(e){
    console.error('[notarize]',e.message);
    res.status(500).json({success:false,error:e.message});
  }finally{
    if(serverHash){ delete DB.pending[serverHash]; saveDB(); }
  }
});

/* ---------- Verify ---------- */
app.post('/api/verify',upload.single('doc'),(req,res)=>{
  const buf=req.file?.buffer; if(!buf) return res.status(400).json({success:false,error:'No file'});
  const h=sha256(buf); const hit=DB.files[h];
  if(hit) return res.json({success:true,matched:true,hash:'0x'+h,...hit,attestations:DB.attestations[h]||[]});
  res.json({success:true,matched:false,hash:'0x'+h});
});

/* ---------- SSE ---------- */
app.get('/events',(req,res)=>{
  res.setHeader('Content-Type','text/event-stream');
  res.setHeader('Cache-Control','no-cache');
  res.setHeader('Connection','keep-alive');
  res.flushHeaders();
  res.write(`data: ${JSON.stringify({type:'hello',now:Date.now(),hcsTopicId:HCS_TOPIC_ID||null})}\n\n`);
  clients.add(res); req.on('close',()=>clients.delete(res));
});

/* ---------- Static ---------- */
app.use(express.static(process.cwd()));

/* ---------- Agent subscriber (delay 3s after topic create) ---------- */
async function agent(hashHex,fileId,tokenId){
  try{
    const raw=await new FileContentsQuery().setFileId(fileId).execute(hedera);
    const meta=JSON.parse(Buffer.from(raw).toString('utf8'));
    const checks=[];
    if(!meta.summary) checks.push({id:'no_summary',lvl:'info',msg:'No summary'});
    const att={kind:'hedger.attestation',docHash:meta.hash,fileId,tokenId,
               timestamp:Date.now(),deterministic:meta.deterministic,checks};
    const sig=operatorKey.sign(Buffer.from(JSON.stringify(att)));
    att.signerPubKey=operatorKey.publicKey.toStringRaw();
    att.signature=Buffer.from(sig).toString('base64');
    const attFile=await writeImmutableHfs(att);

    DB.attestations[hashHex]=DB.attestations[hashHex]||[];
    DB.attestations[hashHex].push({fileId:attFile,timestamp:att.timestamp,signerPubKey:att.signerPubKey,sigBase64:att.signature});
    saveDB();
    await publishHcs('hedger.attested',{hash:'0x'+hashHex,attestationFileId:attFile,tokenId,timestamp:att.timestamp});
  }catch(e){console.error('agent',e.message);}
}
async function subscriber(){
  const id=await ensureTopic();
  /* wait 3s so mirror has indexed the new topic */
  await new Promise(r=>setTimeout(r,3000));
  new TopicMessageQuery().setTopicId(id).subscribe(hedera,null,async m=>{
    try{
      const obj=JSON.parse(Buffer.from(m.contents).toString('utf8'));
      send({source:'hcs',...obj});
      if(obj.type==='hedger.notarized'){
        await agent(obj.hash.replace(/^0x/,''),obj.fileId,obj.tokenId);
      }
    }catch{}
  });
}

/* ---------- Boot ---------- */
(async()=>{
  await ensureTopic();
  subscriber();
  const PORT=process.env.PORT||3000;
  app.listen(PORT,()=>console.log(`Hedger @ http://localhost:${PORT} | HCS ${HCS_TOPIC_ID}`));
})();
