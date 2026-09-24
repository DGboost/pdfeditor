import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import vm from 'node:vm';
import type { OfficeSession, OfficeState } from '../src/documents/officeTypes';
import type * as FrameBridge from '../src/documents/frameBridge';
import type * as SessionModule from '../src/documents/officeSession';

const state = (): OfficeState => ({ sessionId: 'test', revision: 0, selectionRevision: 0, ready: true, busy: false, composing: false, canUndo: false, canRedo: false, canSaveModified: true, zoom: 1, enabled: {undo:true,redo:true,bold:true,italic:true,underline:true,fontFamily:true,fontSize:true,color:true,zoom:true}, formatting: { bold: {kind:'uniform',value:false}, italic:{kind:'uniform',value:false}, underline:{kind:'uniform',value:false}, fontFamily:{kind:'uniform',value:'Arial'}, fontSize:{kind:'uniform',value:12}, color:{kind:'uniform',value:'#000000'} }, fonts: [], warnings: [] });
const tick = () => new Promise(resolve => setImmediate(resolve));
function moduleAt<T>(path: string, globals: Record<string, unknown>, require: (id: string) => unknown): T {
  const source = readFileSync(path, 'utf8').replace('import.meta.env.BASE_URL', "'/'");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  vm.runInNewContext(code, { exports, require, Blob, DOMException, URL, console, ...globals });
  return exports as T;
}
function bridge() {
  const handlers = new Map<string, Function>();
  const window = { parent: {}, location: { origin: 'http://localhost' }, addEventListener: (name: string, fn: Function) => handlers.set(name, fn), removeEventListener: (name: string) => handlers.delete(name) };
  const api = moduleAt<typeof FrameBridge>('src/documents/frameBridge.ts', { window }, () => ({ OFFICE_COMMAND_TYPES: Object.keys(state().enabled) }));
  const messages: { type: string; payload: unknown }[] = [];
  const port = { onmessage: null as ((event: {data: unknown}) => void) | null, postMessage: (message: {type: string; payload: unknown}) => messages.push(message), start() {}, close() {} };
  let current = state();
  let publish: Function = () => {};
  let sequence = 0;
  const engine: OfficeSession = { getState: () => current, subscribe: fn => { publish = fn; return () => {}; }, execute: async () => ({ok:true}), flush: async () => true, captureCheckpoint: async () => ({revision:0,checkpoint:{kind:'native',format:'docx',bytes:new Blob(['x']),warnings:[]}}), serialize: async () => ({revision:0,bytes:new Blob(['x']),warnings:[]}), dispose() {} };
  const guest = api.serveOfficeFrame(async () => engine);
  handlers.get('message')!({ source: window.parent, origin: window.location.origin, ports: [port], data: { channel:'pdfeditor-engine', version:1, sessionId:'test', requestId:0, type:'connect', payload:null } });
  const send = async (type: string, payload: unknown) => { port.onmessage!({ data: { channel:'pdfeditor-engine', version:1, sessionId:'test', requestId:++sequence, type, payload } }); await tick(); return messages.at(-1)!; };
  return { send, guest, messages, engine, publish: (value: OfficeState) => publish(value), setState: (value: OfficeState) => {current = value;} };
}
test('guest disposal explicitly notifies host after fatal state failure', async () => {
  const b = bridge();
  await b.send('open', { format:'docx', source:new Blob(['source']), fileName:'x.docx', initialRevision:0 });
  b.publish({ ...state(), revision: -1 });
  assert.equal(b.messages.at(-1)!.type, 'session-closed');
});
test('zoom ignores selection drift but formatting and composition remain guarded', async () => {
  const b = bridge();
  await b.send('open', { format:'docx', source:new Blob(['source']), fileName:'x.docx', initialRevision:0 });
  b.setState({...state(), selectionRevision:1});
  const zoom = (await b.send('execute', {command:{type:'zoom',value:1.2},selectionRevision:0})).payload;
  assert.ok(zoom && typeof zoom === 'object' && 'ok' in zoom && zoom.ok === true);
  const bold = (await b.send('execute', {command:{type:'bold'},selectionRevision:0})).payload;
  assert.ok(bold && typeof bold === 'object' && 'ok' in bold && bold.ok === false);
  b.setState({...state(), selectionRevision:1, composing:true});
  const composing = (await b.send('execute', {command:{type:'zoom',value:1.2},selectionRevision:1})).payload;
  assert.ok(composing && typeof composing === 'object' && 'ok' in composing && composing.ok === false);
});
test('session serializes execute, flush and thumbnails, and disposal settles stalled and queued calls', async () => {
  const calls: string[] = [];
  let release!: () => void;
  const engine: OfficeSession = { getState:state, subscribe:() => () => {}, execute:async () => { calls.push('execute'); await new Promise<void>(resolve => {release = resolve;}); return {ok:true}; }, flush:async () => {calls.push('flush'); return true;}, captureCheckpoint:async () => { throw new Error('unused'); }, serialize:async () => { throw new Error('unused'); }, pageView:{execute:async () => ({ok:true}),thumbnail:async () => {calls.push('thumbnail');return new Blob(['image']);}}, dispose() {} };
  const api = moduleAt<typeof SessionModule>('src/documents/officeSession.ts', {}, () => ({createDocxSession:async () => engine}));
  const session = await api.createOfficeSession({format:'docx', signal:new AbortController().signal, source:new Blob(['x']), fileName:'x.docx',sessionId:'test',mount:{isConnected:true,clientWidth:10,clientHeight:10} as HTMLElement});
  const first = session.execute({type:'bold'}); const second = session.flush(); const thumbnail = session.pageView!.thumbnail(0,0);
  await tick(); assert.deepEqual(calls, ['execute']);
  release(); await first; await second; await thumbnail; assert.deepEqual(calls, ['execute','flush','thumbnail']);
  const stalled = session.execute({type:'bold'}); const queued = session.flush(); const queuedThumbnail = session.pageView!.thumbnail(0,0);
  await tick(); session.dispose();
  const settled = await Promise.race([Promise.allSettled([stalled,queued,queuedThumbnail]), tick().then(() => 'pending')]);
  assert.notEqual(settled, 'pending');
  assert.equal((settled as PromiseSettledResult<unknown>[]).every(result => result.status === 'rejected'), true);
});

test('terminal host notification rejects pending flush while ordinary engine errors do not close it', async () => {
  const handlers = new Map<string, () => void>();
  const notifications: string[] = [];
  let receive: ((event: {data: unknown}) => void) | null = null;
  const notify = (type: string, payload: unknown, requestId = 0) => receive?.({data:{channel:'pdfeditor-engine',version:1,sessionId:'test',requestId,type,payload}});
  const port = {
    get onmessage() { return receive; }, set onmessage(value) { receive = value; },
    onmessageerror: null, close() {},
    postMessage(message: {type:string;requestId:number}) {
      if (message.type === 'open') queueMicrotask(() => notify('open:result', state(), message.requestId));
    },
  };
  const frame = { style:{cssText:''}, contentWindow:{postMessage:() => queueMicrotask(() => notify('connected',null))}, addEventListener:(name:string,fn:() => void) => handlers.set(name,fn), removeEventListener:(name:string) => handlers.delete(name), remove() {} };
  const mount = { appendChild:() => handlers.get('load')!(), dispatchEvent:(event: {type:string}) => {notifications.push(event.type);return true;} } as unknown as HTMLElement;
  const api = moduleAt<typeof FrameBridge>('src/documents/frameBridge.ts', {
    window:{location:{href:'http://localhost/',origin:'http://localhost'}}, document:{createElement:() => frame},
    MessageChannel:class {port1=port;port2={close(){}};}, queueMicrotask,
    CustomEvent:class { constructor(public type:string, public options?:unknown) {} },
  }, () => ({OFFICE_COMMAND_TYPES:Object.keys(state().enabled)}));
  const session = await api.createFrameSession({format:'docx',source:new Blob(['x']),fileName:'x.docx',sessionId:'test',signal:new AbortController().signal,mount},'/engine');
  notify('error','Recoverable save error');
  assert.equal(session.getState().ready,true);
  assert.deepEqual(notifications,['office-error']);
  const pending = session.flush();
  const rejected = assert.rejects(pending,/종료/);
  notify('session-closed',null);
  await rejected;
  assert.equal(session.getState().ready,false);
  await assert.rejects(session.flush(), {name:'AbortError'});
});
