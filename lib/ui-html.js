/** 生成 exact 01-Memory.html（注入真实 DATA/tiers/token/bridge）；只读 UI 本体。 */
import fs from 'node:fs';
import { computeTierOverrides } from './chain-render.js';
import { buildMemoryGraph } from './graph.js';
export function buildExactUiHtml(opts) {
    const { container, subjects, ledger, token, apiPrefix, chainStore, allowEdit = false, chainUnavailableReason = '' } = opts;
    const idx = container.getIndex();
    const graph = buildMemoryGraph(container);
    const entries = idx.entries.map((e) => {
        const f = container.readEntry(e.id);
        return {
            id: e.id, layer: e.layer, t: e.title, s: e.status ?? 'active', d: e.decay_type ?? 'recent',
            u: e.updated, g: (e.tags ?? []).join('/'), src: f?.frontmatter?.source ?? '', f: e.file,
            summary: e.summary ?? '', pr: e.priority ?? 60, c: f?.content ?? '', session: String(f?.frontmatter?.source_session ?? ''),
        };
    });
    const links = graph.links.map((l) => ({ s: l.source, t: l.target, type: l.type }));
    let tiers = {};
    try {
        const r = computeTierOverrides(container, subjects, ledger, 7, 0.1);
        for (const [id, mode] of r.map)
            tiers[id] = mode === 'summary' ? 'snapshot' : mode === 'title' ? 'outline' : mode === 'none' ? 'forgotten' : 'full';
    }
    catch { /* no tiers */ }
    const chainData = { subjects: subjects.list(), entrySessions: Object.fromEntries(entries.filter((e) => e.session).map((e) => [e.id, e.session])) };
    const data = { _note: '真实容器 · exact UI', captured: new Date().toISOString(), total: entries.length, hot_order: idx.hot_order, entries, links };
    const chainRegistry = chainStore ? { available: true, chains: chainStore.list() } : { available: false, chains: [], error: chainUnavailableReason || '链注册表不可用；为避免猜测，当前不展示未经验证的链分组。' };
    const CHAIN_OVERRIDE = `
if (window.__MEMORY_CHAIN__ && !(window.__MEMORY_CHAINS__ && window.__MEMORY_CHAINS__.available === false)) {
  (function(){
    var C = window.__MEMORY_CHAIN__, byId = {};
    var defs = (window.__MEMORY_CHAINS__ && window.__MEMORY_CHAINS__.chains) || [];
    window.__CHAIN_DEBUG__ = { started:true, subjects:(C.subjects||[]).length, sessions:Object.keys(C.entrySessions||{}).length, chains:defs.length };
    (C.subjects||[]).forEach(function(s){ byId[s.id]=s; });
    var syss = (C.subjects||[]).filter(function(s){return s.kind==='system';});
    if (!syss.length) syss=[{id:'sys-all',name:'记忆系统'}];
    var convs = (C.subjects||[]).filter(function(s){return s.kind==='conversation';});
    var convBySession = {};
    convs.forEach(function(c){ if(c.session_id) convBySession[c.session_id]=c; });
    var out = syss.map(function(s){return {name:s.name, projects:{}};});
    var orphans = [], seenChains = {};
    function ensureProject(S, name, chainId){
      if(!S.projects[name]) S.projects[name]={name:name, chainId:chainId||null, rings:{}};
      else if(chainId) S.projects[name].chainId=chainId;
      return S.projects[name];
    }
    function matchedChains(e){
      var tags=(e.g||'').split('/').map(function(t){return t.trim().toLocaleLowerCase();}).filter(Boolean);
      return defs.filter(function(ch){
        var labels=[ch.canonicalTag].concat(ch.aliases||[]).map(function(t){return String(t).trim().toLocaleLowerCase();});
        return labels.some(function(t){return tags.indexOf(t)>=0;});
      });
    }
    ALL.forEach(function(e){
      if (e.layer==='pending' || e.layer==='hot') return;
      var sid=C.entrySessions && C.entrySessions[e.id];
      var c=convBySession[sid];
      if (!sid || !c) { orphans.push(e); return; }
      var matches=matchedChains(e), selected=matches[0]||null;
      e.__chainId=selected?selected.id:null;
      e.__chainMatches=matches.map(function(m){return m.name;});
      var p = c.parent ? byId[c.parent] : null;
      var si = 0;
      if (p && p.parent) syss.forEach(function(s,i){if(p.parent===s.id)si=i;});
      var S=out[si];
      var pname=selected?selected.name:'其他';
      var P=ensureProject(S,pname,selected?selected.id:null);
      if(selected)seenChains[selected.id]=true;
      var d=(c.last_activated||c.last_grown||e.u||'').slice(0,10);
      if(!d)return;
      if(!P.rings[d])P.rings[d]={date:d,entries:[]};
      P.rings[d].entries.push(e);
    });
    if (orphans.length) {
      var root=out[0]; var old=ensureProject(root,'史前/未归',null);
      orphans.forEach(function(e){var d=(e.u||'').slice(0,10);if(!d)return;if(!old.rings[d])old.rings[d]={date:d,entries:[]};old.rings[d].entries.push(e);});
    }
    // 空链不能消失：没有任何条目命中的注册链，放在最新系统下作为空链入口。
    var latest=out[out.length-1];
    defs.forEach(function(ch){if(!seenChains[ch.id])ensureProject(latest,ch.name,ch.id);});
    var TODAY=Date.now();
    out.forEach(function(S){
      var sysAge=null;
      Object.keys(S.projects).forEach(function(k){
        var P=S.projects[k];
        P.ringList=Object.keys(P.rings).sort().map(function(d){
          var r=P.rings[d], age=(TODAY-new Date(d).getTime())/86400000;
          var st=chainState(age,H_DEMO.project);
          return {date:d,entries:r.entries,age:age,state:st,res:resOfState(st)};
        });
        if(!P.ringList.length){P.state=0;P.res='forgotten';P.count=0;P.n=0;P.last='';return;}
        P.state=Math.max.apply(null,P.ringList.map(function(r){return r.state;}));
        P.res=resOfState(P.state); P.count=P.ringList.length;
        P.n=P.ringList.reduce(function(a,r){return a+r.entries.length;},0);
        P.last=P.ringList[P.ringList.length-1].date; P.sysAge=(TODAY-new Date(P.last).getTime())/86400000;
        if(sysAge===null||P.sysAge<sysAge)sysAge=P.sysAge;
      });
      S.projList=Object.keys(S.projects).map(function(k){return S.projects[k];})
        .sort(function(a,b){if(!a.last&&!b.last)return a.name.localeCompare(b.name);if(!a.last)return 1;if(!b.last)return -1;return a.last<b.last?1:-1;});
      S.state=sysAge===null?0:chainState(sysAge,H_DEMO.system);
      S.res=resOfState(S.state); S.count=S.projList.length;
      S.n=S.projList.reduce(function(a,p){return a+p.n;},0);
    });
    window.__CHAIN_DEBUG__.out=out.map(function(S){return {name:S.name,projects:Object.keys(S.projects),projList:S.projList.length};});
    CHAIN=out;
    window.__CHAIN_DEBUG__.applied=true;
  })();
}
`;
    let html = fs.readFileSync(new URL('./memory-ui.html', import.meta.url), 'utf-8');
    const at = html.indexOf('const DATA = ');
    if (at < 0)
        throw new Error('UI DATA marker missing');
    let i = html.indexOf('{', at), depth = 0, end = -1;
    for (; i < html.length; i++) {
        if (html[i] === '{')
            depth++;
        else if (html[i] === '}') {
            depth--;
            if (depth === 0) {
                end = i;
                break;
            }
        }
    }
    if (end < 0)
        throw new Error('UI DATA object malformed');
    const bridge = `
<script>
window.__MEMORY_BRIDGE__ = (function(){
  const H = {'x-memory-token': ${JSON.stringify(token)}, 'content-type': 'application/json'};
  const go = (path, init={}) => fetch(${JSON.stringify(apiPrefix)} + path, Object.assign({headers:H}, init)).then(r=>r.json()).then(j=>{ if(j && j.ok) setTimeout(()=>location.reload(), 80); return j; });
  return {
    save: (id, patch) => go('/entry/' + encodeURIComponent(id), {method:'PUT', body:JSON.stringify(patch)}),
    pin: (id, pinned=true) => go('/pin/' + encodeURIComponent(id), {method:'POST', body:JSON.stringify({pinned})}),
    relocate: (id, layer, reason='') => go('/entry-relocate/' + encodeURIComponent(id), {method:'POST', body:JSON.stringify({layer,reason})}),
    supersede: (id, by, reason='') => go('/entry-supersede/' + encodeURIComponent(id), {method:'POST', body:JSON.stringify({by,reason})}),
    expire: (id, expires) => go('/entry-expire/' + encodeURIComponent(id), {method:'POST', body:JSON.stringify({expires})}),
    confirm: (id) => go('/pending/' + encodeURIComponent(id) + '/confirm', {method:'POST'}),
    discard: (id) => go('/pending/' + encodeURIComponent(id) + '/discard', {method:'POST'}),
    sweep: (force=false) => go('/decay-sweep', {method:'POST', body:JSON.stringify({force})}),
    rollback: () => go('/decay-rollback', {method:'POST', body:'{}'}),
    suggest: (body) => fetch(${JSON.stringify(apiPrefix)} + '/onboarding/suggest', {method:'POST', headers:H, body:JSON.stringify(body||{})}).then(r=>r.json()),
    identity: (fields) => fetch(${JSON.stringify(apiPrefix)} + '/identity', {method:'PUT', headers:H, body:JSON.stringify(fields)}).then(r=>r.json()).then(j=>{if(j&&j.ok){try{window.parent.dispatchEvent(new Event('dsh-identity-changed'))}catch(e){}}return j}),
    getIdentity: () => fetch(${JSON.stringify(apiPrefix)} + '/identity?ts=' + Date.now(), {headers:H, cache:'no-store'}).then(r=>r.json()),
    activate: (id) => fetch(${JSON.stringify(apiPrefix)} + '/entry-activate/' + encodeURIComponent(id), {method:'POST', headers:H}).then(r=>r.json()),
    chainAudit: async () => { const r=await fetch(${JSON.stringify(apiPrefix)} + '/chains/audit?ts=' + Date.now(), {headers:H,cache:'no-store'}); return r.json(); },
    loadChains: async () => { const j=await fetch(${JSON.stringify(apiPrefix)} + '/chains?ts=' + Date.now(), {headers:H,cache:'no-store'}).then(r=>r.json()); if(!j||!j.ok)throw new Error((j&&j.error)||'链 API 读取失败'); const chains=(j.data.chains||[]).map(c=>({id:c.id,name:c.name,canonicalTag:c.canonicalTag,aliases:c.aliases||[],createdAt:c.createdAt,updatedAt:c.updatedAt})); const current=(window.__MEMORY_CHAINS__&&window.__MEMORY_CHAINS__.chains)||[]; if(JSON.stringify(chains)!==JSON.stringify(current)){window.__MEMORY_CHAINS__={available:true,chains};setTimeout(()=>location.reload(),80);return j;} window.__MEMORY_API_CHAINS_READY__=true; try{renderChain();if(typeof editing!=='undefined'&&editing)renderChainSelector()}catch(e){} return j; },
    createChain: async (body) => { const j=await fetch(${JSON.stringify(apiPrefix)} + '/chains', {method:'POST',headers:H,body:JSON.stringify(body||{})}).then(r=>r.json()); if(j&&j.ok){try{VIEW.lens='chain';VIEW.sys=Math.max(0,CHAIN.length-1);VIEW.proj=j.data.name;VIEW.ring=null;saveView()}catch(e){}setTimeout(()=>location.reload(),80)} return j; },
    renameChain: async (id, name) => { const old=(window.__MEMORY_CHAINS__&&window.__MEMORY_CHAINS__.chains||[]).find(c=>c.id===id); const j=await fetch(${JSON.stringify(apiPrefix)} + '/chains/' + encodeURIComponent(id), {method:'PATCH',headers:H,body:JSON.stringify({name})}).then(r=>r.json()); if(j&&j.ok){if(old&&VIEW.proj===old.name)VIEW.proj=j.data.name;saveView();setTimeout(()=>location.reload(),80)} return j; },
    deleteChain: async (id) => { const old=(window.__MEMORY_CHAINS__&&window.__MEMORY_CHAINS__.chains||[]).find(c=>c.id===id); const j=await fetch(${JSON.stringify(apiPrefix)} + '/chains/' + encodeURIComponent(id), {method:'DELETE',headers:H}).then(r=>r.json()); if(j&&j.ok){if(old&&VIEW.proj===old.name)VIEW.proj=null;saveView();setTimeout(()=>location.reload(),80)} return j; },
    rollbackChain: (batch) => go('/chains/rollback/' + encodeURIComponent(batch), {method:'POST',body:'{}'}),
  };
})();
window.__MEMORY_BRIDGE__.loadChains().catch(function(error){
  window.__MEMORY_CHAIN_API_ERROR__=String(error&&error.message?error.message:error);
  var status=document.getElementById('chain-status');
  if(status){status.style.display='block';status.textContent='链 API 暂不可用，编辑入口已禁用：'+window.__MEMORY_CHAIN_API_ERROR__;}
  var create=document.getElementById('chain-create');if(create)create.disabled=true;
  var select=document.getElementById('d-chain');if(select)select.disabled=true;
});
(function(){
  var btn = document.getElementById('d-save');
  if (!btn) return;
  btn.onclick = async function(){
    var e = byId.get(editing); if(!e) return;
    // Normalize registered chain tags against the current selector even when the user keeps the default first match.
    // This ensures multi-match legacy entries are saved with exactly one canonical chain tag.
    if (typeof applyChainSelectionToDraft === 'function') applyChainSelectionToDraft();
    var body = { title: draft.title, summary: draft.summary, priority: Number(draft.priority), content: draft.content, tags: draft.tags.slice() };
    var j = await window.__MEMORY_BRIDGE__.save(editing, body);
    if (!j || !j.ok) { document.getElementById('d-state').textContent = '保存失败：' + ((j && j.error) || 'unknown'); return; }
    e.t = draft.title; e.summary = draft.summary; e.pr = body.priority; e.c = draft.content; e.g = draft.tags.join('/');
    if (typeof renderTags === 'function') renderTags(); if (typeof renderChainSelector === 'function') renderChainSelector();
    mdCache.delete(e.id); document.getElementById('d-title').textContent = e.t; markDirty(); render(); focusItem(e.id);
    document.getElementById('d-state').textContent = '已保存（真实落盘）';
  };
})();
(function(){
  var bar=document.querySelector('.titlebar');if(!bar)return;
  var b=document.createElement('button');b.title='刷新';b.setAttribute('aria-label','刷新');
  b.innerHTML='<svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M21 3v6h-6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  b.style.cssText='margin-left:auto;width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;padding:0;border:0;border-radius:7px;background:var(--card2);color:var(--text2);cursor:pointer';
  b.onmouseenter=function(){b.style.background='var(--hover)';b.style.color='var(--text)'};
  b.onmouseleave=function(){b.style.background='var(--card2)';b.style.color='var(--text2)'};
  b.onclick=function(){location.reload()};bar.appendChild(b);
})();
(function(){
  function openId(){
    var old=document.getElementById('idcfg'); if(old){old.remove();return}
    var wn=document.querySelector('.wname'), wrap=document.querySelector('.wava');
    var ident=(window.__MEM_IDENTITY__||{});
    var curName=String(ident.name||''); var curCall=String(ident.callName||'');
    var curGender=String(ident.gender||''); var curAvatar=String(ident.avatar||'');
    var m=document.createElement('div'); m.id='idcfg';
    var _br=document.querySelector('.ballwrap').getBoundingClientRect();
    m.style.cssText='position:fixed;left:'+Math.round(_br.left+14)+'px;top:'+Math.round(_br.top+60)+'px;z-index:10000;background:var(--card);border-radius:16px;box-shadow:var(--dsw-elevation-prominent,0 8px 24px rgba(0,0,0,.12));padding:12px 14px;display:flex;flex-direction:column;gap:8px;min-width:230px';
    var inputStyle='font:inherit;font-size:13px;border:none;border-radius:8px;padding:7px 10px;outline:none;background:var(--card2);color:var(--text)';
    var btnStyle='font:inherit;font-size:12px;border:none;border-radius:8px;padding:6px 10px;cursor:pointer';
    m.innerHTML='<div style="display:flex;align-items:center;gap:10px">'
      +'<span id="id-ava" style="width:40px;height:40px;border-radius:50%;background:var(--card2);display:inline-flex;align-items:center;justify-content:center;overflow:hidden;flex:0 0 auto;font-size:11px;color:var(--text2)">'+(curAvatar?'<img src="'+curAvatar+'" style="width:100%;height:100%;object-fit:cover">':'头像')+'</span>'
      +'<label style="font-size:12px;border-radius:8px;padding:6px 10px;cursor:pointer;background:var(--card2);color:var(--text)">选一张<input id="id-file" type="file" accept="image/*" style="display:none"></label>'
      +'<button id="id-del" style="'+btnStyle+';background:transparent;color:var(--text2)'+(curAvatar?'':';display:none')+'">去掉</button></div>'
      +'<label style="font-size:11.5px;color:var(--text2)">你的名字（我怎么称呼你）</label><input id="id-call" value="'+curCall.replace(/"/g,'&quot;')+'" placeholder="例如：小林" style="'+inputStyle+'">'
      +'<label style="font-size:11.5px;color:var(--text2)">我的名字（你怎么称呼我）</label><input id="id-name" value="'+curName.replace(/"/g,'&quot;')+'" placeholder="怎么称呼你" style="'+inputStyle+'">'
      +'<label style="font-size:11.5px;color:var(--text2)">性别（决定胶囊里那个符号）</label><div style="display:flex;gap:6px" id="id-genders"></div>'
      +'<div style="display:flex;gap:6px;justify-content:flex-end"><button id="id-cancel" style="'+btnStyle+';background:var(--card2);color:var(--text2)">取消</button><button id="id-save" style="'+btnStyle+';background:var(--text);color:var(--bg);font-weight:600">保存</button></div>';
    document.body.appendChild(m);
    var ava=m.querySelector('#id-ava'), file=m.querySelector('#id-file'), del=m.querySelector('#id-del'), genders=m.querySelector('#id-genders');
    var draft=curAvatar;
    function setAva(v){draft=v;window.__MEM_IDENTITY__=Object.assign({},window.__MEM_IDENTITY__||{},{avatar:v});ava.innerHTML=v?'<img src="'+v+'" style="width:100%;height:100%;object-fit:cover">':'头像';del.style.display=v?'':'none'}
    function setGender(v){curGender=v;[].forEach.call(genders.children,function(b){b.style.background=b.dataset.v===v?'var(--text)':'var(--card2)';b.style.color=b.dataset.v===v?'var(--bg)':'var(--text2)'})}
    ['男','女',''].forEach(function(v){var b=document.createElement('button');b.dataset.v=v;b.textContent=v||'不显示';b.style.cssText=btnStyle+';font-weight:600';b.onclick=function(){setGender(v)};genders.appendChild(b)});
    setGender(curGender);
    file.onchange=function(){var f=file.files&&file.files[0];if(!f)return;var r=new FileReader();r.onload=async function(){try{setAva(String(r.result||''));var j=await window.__MEMORY_BRIDGE__.identity({avatar:draft});if(!j||!j.ok)throw new Error((j&&j.error)||'unknown');}catch(e){setAva(curAvatar);alert('头像保存失败：'+(e&&e.message?e.message:e))}};r.readAsDataURL(f)};
    del.onclick=async function(){var old=draft;setAva('');try{var j=await window.__MEMORY_BRIDGE__.identity({avatar:''});if(!j||!j.ok)throw new Error((j&&j.error)||'unknown');}catch(e){setAva(old);alert('删除头像失败：'+(e&&e.message?e.message:e))}};
    m.querySelector('#id-cancel').onclick=function(){m.remove()};
    m.querySelector('#id-save').onclick=async function(){var n=m.querySelector('#id-name').value.trim(),c=m.querySelector('#id-call').value.trim();try{var j=await window.__MEMORY_BRIDGE__.identity({name:n,callName:c,gender:curGender});if(!j||!j.ok)throw new Error((j&&j.error)||'unknown');window.__MEM_IDENTITY__={name:n,callName:c,gender:curGender,avatar:draft};if(wn)wn.innerHTML=(n||c||'未命名')+(curGender==='男'?'<span class="wsex male">♂</span>':curGender==='女'?'<span class="wsex female">♀</span>':'');m.remove()}catch(e){alert('身份保存失败：'+(e&&e.message?e.message:e))}};
  }
  var w=document.querySelector('.who');
  if(w){
    w.style.cursor='pointer';
    // 点击可能被 canvas/图层吃掉：用文档捕获阶段按身份卡矩形兜底
    w.addEventListener('click',function(e){e.preventDefault();e.stopPropagation();openId()});
    document.addEventListener('click',function(e){
      var r=w.getBoundingClientRect();
      var inside=w.contains(e.target)||(e.clientX>=r.left&&e.clientX<=r.right&&e.clientY>=r.top&&e.clientY<=r.bottom);
      if(inside){e.preventDefault();e.stopPropagation();openId()}
    },true);
  }
})();
(function(){
  document.addEventListener('click',function(e){
    var b=e.target&&e.target.closest&&e.target.closest('[data-lens]');
    if(b){try{setLens(b.getAttribute('data-lens'))}catch(err){}}
    var ed=e.target&&e.target.closest&&e.target.closest('[data-edit]');
    if(ed){try{openDrawer(ed.getAttribute('data-edit'))}catch(err){}}
  },true);
})();
(function(){
  window.__MEMORY_BRIDGE__.getIdentity().then(function(j){
    var f=j&&j.data&&j.data.fields; if(!f) return; window.__MEM_IDENTITY__=f;
    var wn=document.querySelector('.wname'), wava=document.querySelector('.wava');
    if(wn){var n=f.name||f.callName||'未命名';var g=f.gender||'';wn.innerHTML=n+(g==='男'?'<span class="wsex male">♂</span>':g==='女'?'<span class="wsex female">♀</span>':'')}
    if(wava){if(f.avatar){wava.innerHTML='<img src="'+String(f.avatar)+'" style="width:100%;height:100%;object-fit:cover">'}else{wava.innerHTML='<span class="ph">头像</span>'}}
  }).catch(function(){});
})();
</script>
<script>
(function(){
  var ex=document.getElementById('d-expire');
  if(ex) ex.addEventListener('click',function(){
    if(!editing) return;
    if(!confirm('把这条标记为已过期？')) return;
    window.__MEMORY_BRIDGE__.expire(editing,new Date().toISOString().slice(0,10)).then(function(j){if(!j||!j.ok)alert('标记过期失败：'+((j&&j.error)||'unknown'))});
  });
  var sp=document.getElementById('d-supersede');
  if(sp) sp.addEventListener('click',function(){
    if(!editing) return;
    var by=prompt('由哪条条目取代？（输入 id，例如 h03）');
    if(!by) return;
    window.__MEMORY_BRIDGE__.supersede(editing,by,'UI 取代').then(function(j){if(!j||!j.ok)alert('取代失败：'+((j&&j.error)||'unknown'))});
  });
})();
</script>
<script>
(function(){
  document.addEventListener('click', async function(ev){
    var b=ev.target&&ev.target.closest&&ev.target.closest('#d-save');
    if(!b) return;
    ev.preventDefault(); ev.stopImmediatePropagation();
    if(b.disabled) return;
    var e=byId.get(editing);
    if(!e){ document.getElementById('d-state').textContent='保存失败：条目不存在'; return; }
    var body={title:draft.title,summary:draft.summary,priority:Number(draft.priority),content:draft.content,tags:draft.tags.slice()};
    try{
      var j=await window.__MEMORY_BRIDGE__.save(editing,body);
      if(!j||!j.ok){document.getElementById('d-state').textContent='保存失败：'+((j&&j.error)||'unknown');return}
      e.t=draft.title;e.summary=draft.summary;e.pr=body.priority;e.c=draft.content;e.g=draft.tags.join('/');
      mdCache.delete(e.id);document.getElementById('d-title').textContent=e.t;markDirty();render();focusItem(e.id);
      document.getElementById('d-state').textContent='已保存（真实落盘）';
    }catch(err){document.getElementById('d-state').textContent='保存失败：'+(err&&err.message?err.message:err)}
  },true);
})();
</script>
<script>try{renderStats()}catch(e){console.error(e)};setTimeout(function(){try{if(!CHAIN[VIEW.sys])VIEW.sys=0;VIEW.proj=null;saveView();render()}catch(e){console.error(e)}},60)</script>`;
    html = html.slice(0, at) + 'const DATA = ' + JSON.stringify(data) + ';\nwindow.__MEMORY_TIERS__ = ' + JSON.stringify(tiers) + ';\nwindow.__MEMORY_CHAIN__ = ' + JSON.stringify(chainData) + ';\nwindow.__MEMORY_CHAINS__ = ' + JSON.stringify(chainRegistry) + ';\nwindow.__MEMORY_ALLOW_EDIT__ = ' + JSON.stringify(allowEdit) + ';\nwindow.__MEMORY_API_CHAINS_READY__ = false;' + html.slice(end + 1);
    const marker = '/* 默认落在**最早的**系统';
    if (html.includes(marker))
        html = html.replace(marker, CHAIN_OVERRIDE + '\n' + marker);
    html = html.replace('</head>', '<style>.item .h .editbtn{opacity:1!important}.ballwrap .who{position:absolute;z-index:20;pointer-events:auto!important}#build-stamp{display:none!important}.who{cursor:pointer}.dcurve circle{fill:#3b82f6!important}.dcurve line[stroke="#0f1115"]{stroke:#3b82f6!important}</style></head>');
    html = html.replace('</body>', bridge + '</body>');
    return html;
}
