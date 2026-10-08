import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { randomUUID, timingSafeEqual } from 'node:crypto';
const {token,account,port} = JSON.parse(readFileSync(new URL('./extension/bridge-local.json', import.meta.url)));
if (!/^[a-f0-9]{64}$/.test(token) || !/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(account) || !Number.isInteger(port) || port<1024 || port>65535)
  throw new Error('Invalid local configuration; run: node setup.mjs gmail <your email>');
let pending = null;
let pollResponse = null;
const json = (res,status,data) => {res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
function deliver() {
  if (pending && !pending.sent && pollResponse && !pollResponse.destroyed) {
    pending.sent=true;json(pollResponse,200,pending.request);pollResponse=null;
  }
}
const bridge = createServer(async (req,res) => {
  const expected=Buffer.from('Bearer '+token), provided=Buffer.from(req.headers.authorization || '');
  const origin=req.headers.origin;
  if (req.headers.host !== '127.0.0.1:'+port || (origin && !/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) ||
      provided.length!==expected.length || !timingSafeEqual(provided,expected)) return json(res,403,{error:'Forbidden'});
  if (req.method==='GET' && req.url==='/poll') {
    if (pollResponse) json(pollResponse,409,{error:'Another poll is active'});
    pollResponse=res;
    const timer=setTimeout(()=>{if(pollResponse===res)pollResponse=null;if(!res.writableEnded)json(res,200,{});},20000);
    res.on('close',()=>{clearTimeout(timer);if(pollResponse===res)pollResponse=null;});
    deliver();return;
  }
  if (req.method==='POST' && req.url==='/response') {
    try {
      let body='',size=0;
      for await(const chunk of req) {size+=chunk.length;if(size>2_000_000){json(res,413,{error:'Response too large'});req.destroy();return;}body+=chunk;}
      const response=JSON.parse(body);
      if (!pending || response.id!==pending.request.id) return json(res,404,{error:'No matching request'});
      if (!response.error && response.data?.account!==account) return json(res,400,{error:'Account mismatch'});
      pending.resolve(response);pending=null;json(res,200,{ok:true});return;
    } catch {return json(res,400,{error:'Invalid response'});}
  }
  json(res,404,{error:'Not found'});
});
await new Promise((resolve,reject)=>{bridge.once('error',reject);bridge.listen(port,'127.0.0.1',resolve);}).catch(error=>{
  throw error.code==='EADDRINUSE' ? new Error('Port '+port+' is in use: another app already runs the Randstad Gmail server. Close it, or use it from one app only.') : error;
});
const server = new Server({name:'randstad-gmail',version:'1.0.0'},{capabilities:{tools:{}}});
const querySchema={type:'string',minLength:1,maxLength:2000,description:'Gmail search query. Results cover only the first rendered page.'};
server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[
  {name:'account_identity',description:'Verify the live Randstad Gmail account.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true}},
  {name:'search_emails',description:'Search Randstad Gmail, returning the first rendered page. Does not open messages.',inputSchema:{type:'object',properties:{query:querySchema,limit:{type:'integer',minimum:1,maximum:50,default:10}},required:['query'],additionalProperties:false},annotations:{readOnlyHint:true}},
  {name:'read_email',description:'Read a thread returned by the same search query, only if already read. Unread threads are refused. Returns visible expanded messages only.',inputSchema:{type:'object',properties:{query:querySchema,emailId:{type:'string',pattern:'^[a-f0-9]{10,32}$'}},required:['query','emailId'],additionalProperties:false},annotations:{readOnlyHint:true}},
  {name:'read_email_and_mark_read',description:'Open a Randstad thread and read its visible expanded messages. This MARKS UNREAD MAIL AS READ. Use only when the user authorizes that read-state change. Use read_email for already-read threads without changing unread state.',inputSchema:{type:'object',properties:{query:querySchema,emailId:{type:'string',pattern:'^[a-f0-9]{10,32}$'}},required:['query','emailId'],additionalProperties:false},annotations:{readOnlyHint:false,destructiveHint:false}},
  {name:'archive_email',description:'Archive ONE Randstad inbox thread by exact ID without opening it. Provide a narrow Gmail query matching only that thread; omit in: and label: operators because Inbox is added automatically. Removes Inbox, does not delete or send. Verifies removal in a fresh Gmail tab. Only use when archiving is authorized; after errors inspect Gmail before retrying.',inputSchema:{type:'object',properties:{query:querySchema,emailId:{type:'string',pattern:'^[a-f0-9]{10,32}$'}},required:['query','emailId'],additionalProperties:false},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false}},
  {name:'create_email_draft' ,description:'Create an UNSENT plain-text draft in Randstad Gmail for the user to review and send. One recipient; no attachments or reply threading. Do not automatically retry a timeout or error: a draft may already exist. Use a distinct subject so the saved draft can be identified.',inputSchema:{type:'object',properties:{to:{type:'string'},subject:{type:'string',minLength:1,maxLength:200},body:{type:'string',minLength:1,maxLength:50000}},required:['to','subject','body'],additionalProperties:false},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false}}
]}));
server.setRequestHandler(CallToolRequestSchema,async({params})=>{
  try {
    const action={account_identity:'identity',search_emails:'search',read_email:'read',read_email_and_mark_read:'read_and_mark_read',create_email_draft:'draft',archive_email:'archive'}[params.name];
    if(!action)throw new Error('Tool not allowed');
    const args=params.arguments || {};
    const allowed=action==='identity'?[]:action==='draft'?['to','subject','body']:action==='search'?['query','limit']:['query','emailId'];
    if(Object.keys(args).some(k=>!allowed.includes(k)))throw new Error('Unknown argument');
    if(action==='draft') {
      if(typeof args.to!=='string'||args.to.length>254||!(/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(args.to)))throw new Error('Invalid recipient');
      if(typeof args.subject!=='string'||!args.subject.trim()||args.subject!==args.subject.trim()||args.subject.length>200||/[\\\r\n"\x00-\x1f]/.test(args.subject))throw new Error('Invalid draft subject');
      if(typeof args.body!=='string'||!args.body.trim()||args.body.length>50000)throw new Error('Invalid draft body');
    } else if(action!=='identity' && (typeof args.query!=='string'||!args.query.trim()||args.query.length>2000))throw new Error('Invalid query');
    if(['read','read_and_mark_read','archive'].includes(action) && !/^[a-f0-9]{10,32}$/.test(args.emailId || ''))throw new Error('Invalid thread ID');
    if(action==='archive' && /\b(in|label):/i.test(args.query))throw new Error('Archive query must omit in: and label: operators; Inbox is added automatically');
    if(args.limit!==undefined && (!Number.isInteger(args.limit)||args.limit<1||args.limit>50))throw new Error('Invalid limit');
    if(pending)throw new Error('Another mailbox operation is in progress');
    const request={id:randomUUID(),action,...args};
    let timer;
    const result=await new Promise((resolve,reject)=>{
      pending={request,resolve,sent:false};
      timer=setTimeout(()=>{
        const delivered=pending?.request.id===request.id && pending.sent;
        const mayHaveOpened=delivered && action==='read_and_mark_read';
        if(pending?.request.id===request.id)pending=null;
        reject(new Error('Chrome extension unavailable or operation timed out' +
          (mayHaveOpened ? '; the thread may have been opened and marked read. Do not retry automatically.' : '') +
          (delivered&&action==='archive' ? '; the thread may already be archived. Inspect Gmail before retrying.' : '') +
          (delivered&&action==='draft' ? '; an unsent draft may exist. Inspect Drafts before retrying.' : '')));
      },60000);
      deliver();
    }).finally(()=>clearTimeout(timer));
    if(result.error)throw new Error(result.error);
    return {content:[{type:'text',text:JSON.stringify(result.data)}]};
  }catch(error){return {isError:true,content:[{type:'text',text:error.message}]};}
});
await server.connect(new StdioServerTransport());
process.stdin.on('end',()=>{bridge.close();process.exit(0);});
