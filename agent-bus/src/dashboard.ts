/**
 * Self-contained status dashboard served by `agent-bus serve`. No external assets,
 * no framework — styled with shadcn/ui's BASELINE design system ported to plain CSS:
 * the default theme tokens (light + dark via prefers-color-scheme) and the Card /
 * Badge / Table / Separator / Progress primitives. Three panels:
 *   1. Overall utilization — workers active/idle/offline + how the fleet is
 *      resourced across the ranked daily priorities.
 *   2. Workers — a 2-column grid: canonical id (worker-<n>), current task, and
 *      which daily priority it serves (assigned = filled badge, inferred from
 *      branch = outlined ~badge).
 *   3. Foreman effectiveness — the foreman's OWN hindsight verdict on its
 *      recommendations (validated vs later-contradicted), recency-weighted. Not
 *      the principal's acceptance rate.
 *
 * Agents are addressed by canonical id everywhere (foreman, worker-<n>) — there
 * is no persona/roster layer. Polls /api/state every 2s.
 */

/** Render the dashboard page (principal name comes from agent-bus.config.json). */
export function dashboardHtml(principal: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<link rel="icon" href="data:," />
<title>agent-bus</title>
<style>
  /* shadcn/ui baseline theme tokens (default / "zinc") */
  :root {
    --background:0 0% 100%; --foreground:240 10% 3.9%;
    --card:0 0% 100%; --card-foreground:240 10% 3.9%;
    --primary:240 5.9% 10%; --primary-foreground:0 0% 98%;
    --secondary:240 4.8% 95.9%; --secondary-foreground:240 5.9% 10%;
    --muted:240 4.8% 95.9%; --muted-foreground:240 3.8% 46.1%;
    --accent:240 4.8% 95.9%; --accent-foreground:240 5.9% 10%;
    --destructive:0 72% 51%; --destructive-foreground:0 0% 98%;
    --border:240 5.9% 90%; --input:240 5.9% 90%; --ring:240 5.9% 10%;
    --success:142 71% 45%; --warning:38 92% 50%;
    --chart-1:220 70% 50%; --chart-2:160 60% 45%; --chart-3:30 80% 55%; --chart-4:280 65% 60%; --chart-5:340 75% 55%;
    --radius:0.65rem;
    --font-sans:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
    --font-mono:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --background:240 10% 3.9%; --foreground:0 0% 98%;
      --card:240 10% 5.5%; --card-foreground:0 0% 98%;
      --primary:0 0% 98%; --primary-foreground:240 5.9% 10%;
      --secondary:240 3.7% 15.9%; --secondary-foreground:0 0% 98%;
      --muted:240 3.7% 15.9%; --muted-foreground:240 5% 64.9%;
      --accent:240 3.7% 15.9%; --accent-foreground:0 0% 98%;
      --destructive:0 72% 51%; --destructive-foreground:0 0% 98%;
      --border:240 3.7% 15.9%; --input:240 3.7% 15.9%; --ring:240 4.9% 83.9%;
      --success:142 69% 58%; --warning:38 92% 60%;
      --chart-1:220 70% 55%; --chart-2:160 60% 50%; --chart-3:30 85% 60%; --chart-4:280 65% 65%; --chart-5:340 75% 60%;
    }
  }
  * { box-sizing:border-box; }
  body { margin:0; background:hsl(var(--background)); color:hsl(var(--foreground)); font-family:var(--font-sans); font-size:14px; -webkit-font-smoothing:antialiased; }
  .mono { font-family:var(--font-mono); }
  .muted { color:hsl(var(--muted-foreground)); }

  /* Layout */
  header { display:flex; align-items:center; gap:12px; padding:18px 24px; max-width:1200px; margin:0 auto; }
  header .title { font-size:18px; font-weight:600; letter-spacing:-0.02em; }
  header .title .accent { color:hsl(var(--muted-foreground)); font-weight:500; }
  header .sub { color:hsl(var(--muted-foreground)); font-size:13px; }
  header .spacer { margin-left:auto; }
  main { max-width:1200px; margin:0 auto; padding:0 24px 40px; display:flex; flex-direction:column; gap:16px; }

  /* Card */
  .card { border:1px solid hsl(var(--border)); border-radius:var(--radius); background:hsl(var(--card)); color:hsl(var(--card-foreground)); box-shadow:0 1px 2px 0 hsl(240 10% 3.9% / 0.04); }
  .card-header { display:flex; align-items:center; gap:10px; padding:18px 20px 0; }
  .card-title { font-size:15px; font-weight:600; letter-spacing:-0.01em; }
  .card-desc { color:hsl(var(--muted-foreground)); font-size:13px; line-height:1.55; padding:6px 20px 0; margin:0; }
  .card-content { padding:16px 20px 20px; }

  /* Badge */
  .badge { display:inline-flex; align-items:center; gap:5px; border:1px solid transparent; border-radius:9999px; padding:2px 9px; font-size:11.5px; font-weight:600; line-height:1.35; white-space:nowrap; }
  .badge-secondary { background:hsl(var(--secondary)); color:hsl(var(--secondary-foreground)); }
  .badge-outline { color:hsl(var(--foreground)); border-color:hsl(var(--border)); }
  .badge-destructive { background:hsl(var(--destructive)); color:hsl(var(--destructive-foreground)); }

  /* Separator */
  .sep { height:1px; background:hsl(var(--border)); border:0; margin:0; }

  /* Table */
  table.tbl { width:100%; border-collapse:collapse; font-size:13.5px; }
  table.tbl th { text-align:left; font-weight:500; color:hsl(var(--muted-foreground)); padding:0 10px 8px; font-size:12px; }
  table.tbl td { padding:9px 10px; border-top:1px solid hsl(var(--border)); vertical-align:middle; }
  table.tbl td.trunc { max-width:0; width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  table.tbl td.right { text-align:right; white-space:nowrap; color:hsl(var(--muted-foreground)); }

  /* Progress */
  .progress { height:8px; background:hsl(var(--secondary)); border-radius:9999px; overflow:hidden; }
  .progress > i { display:block; height:100%; border-radius:9999px; }

  /* Stat tiles */
  .stats { display:flex; gap:24px; }
  .stat .n { font-size:28px; font-weight:700; line-height:1; letter-spacing:-0.02em; }
  .stat .l { font-size:12px; color:hsl(var(--muted-foreground)); margin-top:4px; }
  .stat.active .n { color:hsl(var(--success)); } .stat.idle .n { color:hsl(var(--warning)); } .stat.offline .n { color:hsl(var(--muted-foreground)); }

  /* Overall utilization body */
  .util { display:grid; grid-template-columns:auto minmax(0,1fr); gap:28px; align-items:center; }
  @media (max-width:720px){ .util{ grid-template-columns:1fr; } }
  .prow { display:grid; grid-template-columns:auto 1fr auto; gap:12px; align-items:center; padding:7px 0; }
  .prow + .prow { border-top:1px solid hsl(var(--border)); }
  .prow .lab { min-width:0; }
  .prow .lab .t { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:500; }
  .prow .lab .progress { margin-top:7px; }
  .prow .cnt { color:hsl(var(--muted-foreground)); font-size:13px; white-space:nowrap; }
  .prow .cnt b { color:hsl(var(--foreground)); }
  .prow.zero .lab .t { color:hsl(var(--destructive)); }

  /* Workers grid — equal 2 cols; long text never stretches a track */
  .workers { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; }
  @media (max-width:720px){ .workers{ grid-template-columns:1fr; } }
  .wcard { min-width:0; border:1px solid hsl(var(--border)); border-radius:var(--radius); padding:14px 16px; display:flex; flex-direction:column; gap:9px; background:hsl(var(--card)); }
  .wcard.offline { opacity:.55; }
  .wcard.collide { border-color:hsl(var(--destructive) / 0.6); }
  .wtop { display:flex; align-items:center; gap:8px; min-width:0; }
  .wtop .dot { width:8px; height:8px; border-radius:9999px; flex:0 0 auto; }
  .wtop .nm { font-weight:600; font-size:14.5px; }
  .wtop .wt { color:hsl(var(--muted-foreground)); font-size:11.5px; }
  .wtop .st { margin-left:auto; color:hsl(var(--muted-foreground)); font-size:12px; white-space:nowrap; }
  .wtask { display:flex; gap:7px; align-items:baseline; min-width:0; font-size:13.5px; }
  .wtask .ar { color:hsl(var(--muted-foreground)); flex:0 0 auto; }
  .wtask .tt { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .wtask.none .tt { color:hsl(var(--muted-foreground)); font-style:italic; }
  .wbot { display:flex; align-items:center; gap:9px; min-width:0; }
  .wbot .branch { color:hsl(var(--muted-foreground)); font-size:11.5px; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }

  /* Foreman */
  .fore-top { display:flex; align-items:center; gap:18px; flex-wrap:wrap; margin-bottom:14px; }
  .fore-top .score { font-size:40px; font-weight:700; line-height:1; letter-spacing:-0.02em; color:hsl(var(--muted-foreground)); }
  .fore-top .score.has { color:hsl(var(--foreground)); }
  .fore-top .tags { display:flex; gap:8px; flex-wrap:wrap; }
  .oc-val { color:hsl(var(--success)); } .oc-con { color:hsl(var(--destructive)); }

  .alert { border:1px solid hsl(var(--border)); border-radius:var(--radius); padding:12px 16px; display:flex; flex-direction:column; gap:6px; }
  .alert-warn { border-color:hsl(var(--warning) / 0.5); background:hsl(var(--warning) / 0.08); }
  .alert-row { display:flex; gap:10px; align-items:baseline; min-width:0; }
  .alert-row .q { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .empty { color:hsl(var(--muted-foreground)); font-style:italic; font-size:13px; padding:6px 0; }
  .live { display:inline-flex; align-items:center; gap:6px; color:hsl(var(--muted-foreground)); font-size:12px; }
  .live .pulse { width:7px; height:7px; border-radius:9999px; background:hsl(var(--success)); animation:pulse 2s infinite; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.4} }
  .chips { display:flex; flex-wrap:wrap; gap:8px; }
</style>
</head>
<body>
<header>
  <div>
    <div class="title">agent-bus <span class="accent">· fleet</span></div>
  </div>
  <div class="spacer"></div>
  <span class="live"><span class="pulse"></span> <span id="livetxt">live</span></span>
</header>
<main>
  <div id="needs"></div>
  <div class="card"><div class="card-header"><span class="card-title">Overall utilization</span><span id="util-badge"></span></div><div class="card-content" id="util-body"></div></div>
  <div class="card"><div class="card-header"><span class="card-title">Workers</span><span id="workers-badge"></span></div><div class="card-content" id="workers-body"></div></div>
  <div id="collstrip"></div>
  <div class="card"><div class="card-header"><span class="card-title">Foreman effectiveness</span><span id="fore-badge"></span></div><div class="card-content" id="fore-body"></div></div>
  <div id="others"></div>
</main>
<script>
  function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];}); }
  function age(now,t){ if(t==null) return '—'; var ms=now-t; if(ms<60000) return 'now'; var m=Math.floor(ms/60000); if(m<60) return m+'m'; var h=Math.floor(m/60); return h<24? h+'h':Math.floor(h/24)+'d'; }
  function wtNum(id){ var m=/^worker-(\\d+)$/.exec(id); return m? parseInt(m[1],10):null; }
  var PRINCIPAL=${JSON.stringify(principal)};
  function nmeOnly(id){ return id; }
  function dotColor(s){ return s==='active'?'hsl(var(--success))':s==='idle'?'hsl(var(--warning))':'hsl(var(--muted-foreground))'; }
  var PVAR=['hsl(var(--chart-1))','hsl(var(--chart-2))','hsl(var(--chart-3))','hsl(var(--chart-4))','hsl(var(--chart-5))'];
  function pcolor(i){ return PVAR[i]||'hsl(var(--muted-foreground))'; }
  function prioShort(p){ if(!p) return ''; return String(p).split(/\\s+[—–]\\s+|\\s+-\\s+|\\s*\\(/)[0].trim(); }
  function prioIndex(ref, prios){
    if(!ref) return -1;
    var r=String(ref).toLowerCase().trim();
    for(var i=0;i<prios.length;i++){
      var full=String(prios[i]).toLowerCase();
      var shortp=prioShort(prios[i]).toLowerCase();
      if(full===r || full.indexOf(r)>=0 || (shortp && r.indexOf(shortp)>=0) || (shortp && shortp.indexOf(r)>=0)) return i;
    }
    return -1;
  }
  var ACTIVE={assigned:1,in_progress:1};
  function curTask(tasks,id){
    var m=tasks.filter(function(t){return t.assignee===id && ACTIVE[t.state];});
    m.sort(function(a,b){return b.at-a.at;});
    return m[0]||null;
  }
  var STOP={fix:1,feat:1,chore:1,refactor:1,docs:1,test:1,wip:1,the:1,and:1,for:1,home:1,eng:1,inn:1,main:1,staging:1};
  function tokset(s){ return String(s||'').toLowerCase().split(/[^a-z0-9]+/).filter(function(t){ return t.length>2 && STOP[t]!==1; }); }
  function inferPrioIndex(w, prios){
    var wt=tokset((w.branch||'')+' '+(w.ticket||''));
    if(!wt.length) return -1;
    var best=-1, bestScore=0;
    for(var i=0;i<prios.length;i++){
      var pt=tokset(prios[i]); var score=0;
      wt.forEach(function(t){ if(pt.indexOf(t)>=0) score += (/^[0-9]+$/.test(t)?3:1); });
      if(score>bestScore){ bestScore=score; best=i; }
    }
    return bestScore>0? best : -1;
  }
  function workerPriority(s, w){
    var prios=s.priorities||[];
    var t=curTask(s.tasks,w.id);
    if(t){ return { i:prioIndex(t.priority,prios), src:'task', task:t }; }
    return { i:inferPrioIndex(w,prios), src:'branch', task:null };
  }
  function badge(cls, txt, style){ return '<span class="badge '+cls+'"'+(style?' style="'+style+'"':'')+'>'+txt+'</span>'; }

  function renderUtil(s, workers){
    var prios=s.priorities||[];
    var active=0,idle=0,off=0;
    workers.forEach(function(w){ if(w.state==='active')active++; else if(w.state==='idle')idle++; else off++; });
    var perP=prios.map(function(){return 0;}); var unassigned=0;
    var onduty=workers.filter(function(w){return w.state!=='offline';});
    onduty.forEach(function(w){ var wp=workerPriority(s,w); if(wp.i>=0) perP[wp.i]++; else unassigned++; });
    var denom=Math.max(onduty.length,1);
    document.getElementById('util-badge').innerHTML = badge('badge-secondary', onduty.length+'/'+workers.length+' on duty');
    var rows=prios.map(function(p,i){
      var c=perP[i]; var pct=Math.round(c/denom*100);
      return '<div class="prow'+(c===0?' zero':'')+'">'+
        badge('badge-secondary','P'+(i+1),'background:'+pcolor(i)+';color:#fff')+
        '<div class="lab"><div class="t">'+esc(prioShort(p))+'</div>'+
          '<div class="progress"><i style="width:'+pct+'%;background:'+pcolor(i)+'"></i></div></div>'+
        '<span class="cnt"><b>'+c+'</b> '+(c===1?'worker':'workers')+'</span>'+
      '</div>';
    }).join('');
    if(unassigned>0){
      rows+='<div class="prow">'+badge('badge-outline','·')+
        '<div class="lab"><div class="t muted">off-priority / self-directed</div></div>'+
        '<span class="cnt"><b>'+unassigned+'</b> '+(unassigned===1?'worker':'workers')+'</span></div>';
    }
    document.getElementById('util-body').innerHTML =
      '<div class="util">'+
        '<div class="stats">'+
          '<div class="stat active"><div class="n">'+active+'</div><div class="l">Active</div></div>'+
          '<div class="stat idle"><div class="n">'+idle+'</div><div class="l">Idle</div></div>'+
          '<div class="stat offline"><div class="n">'+off+'</div><div class="l">Offline</div></div>'+
        '</div>'+
        '<div>'+(rows||'<div class="empty">no priorities set — ask the foreman</div>')+'</div>'+
      '</div>';
  }

  // Wake accounting: each wake is one full model turn over the worker's whole
  // context, so wakes/hour is the live cost dial. Amber past 6/h, red past 12/h.
  function wakeBadge(w){
    var h=w.wakesLastHour||0, d=w.wakes24h||0;
    if(!h && !d) return '';
    var style = h>=12? 'color:hsl(var(--destructive));border-color:hsl(var(--destructive))'
              : h>=6?  'color:hsl(var(--warning));border-color:hsl(var(--warning))' : '';
    return badge('badge-outline', h+' wakes/h · '+d+'/24h', style);
  }

  function workerCell(s, w, collide){
    var prios=s.priorities||[];
    var cls='wcard'+(w.state==='offline'?' offline':'')+(collide[w.id]?' collide':'');
    var wp=workerPriority(s,w); var t=wp.task;
    var taskHtml = t
      ? '<div class="wtask"><span class="ar">▸</span><span class="tt">'+esc(t.title)+'</span></div>'
      : '<div class="wtask none"><span class="ar">▸</span><span class="tt">'+(w.state==='offline'?'offline':(w.branch?'self-directed':'no task'))+'</span></div>';
    var ptag;
    if(wp.i>=0 && wp.src==='branch'){
      ptag=badge('badge-outline','~P'+(wp.i+1)+' '+esc(prioShort(prios[wp.i])),'color:'+pcolor(wp.i)+';border-color:'+pcolor(wp.i));
    } else if(wp.i>=0){
      ptag=badge('badge-secondary','P'+(wp.i+1)+' '+esc(prioShort(prios[wp.i])),'background:'+pcolor(wp.i)+';color:#fff');
    } else {
      ptag=badge('badge-outline', t?'off-priority':'—');
    }
    return '<div class="'+cls+'">'+
      '<div class="wtop">'+
        '<span class="dot" style="background:'+dotColor(w.state)+'"></span>'+
        '<span class="nm mono">'+esc(w.id)+'</span>'+
        '<span class="st">'+w.state+' '+age(s.now,w.lastActive)+'</span>'+
      '</div>'+
      taskHtml+
      '<div class="wbot">'+ptag+wakeBadge(w)+(w.branch?'<span class="branch mono">'+esc(w.branch)+'</span>':'')+'</div>'+
    '</div>';
  }

  function renderWorkers(s, workers, collide){
    document.getElementById('workers-badge').innerHTML = badge('badge-secondary', String(workers.length));
    var half=Math.ceil(workers.length/2);
    var left=workers.slice(0,half), right=workers.slice(half);
    var order=[]; for(var i=0;i<half;i++){ order.push(left[i]); if(right[i]) order.push(right[i]); }
    document.getElementById('workers-body').innerHTML =
      '<div class="workers">'+order.map(function(w){return workerCell(s,w,collide);}).join('')+'</div>';
  }

  function renderForeman(s){
    var qs=s.questions||[];
    var recs=qs.filter(function(q){return q.recommendation || q.resolvedBy==='foreman';});
    recs.sort(function(a,b){return b.at-a.at;});
    var val=0,con=0,pend=0;
    recs.forEach(function(q){ var o=q.outcome; if(o==='validated')val++; else if(o==='contradicted')con++; else pend++; });
    var wSum=0,wVal=0,ai=0;
    recs.forEach(function(q){ if(q.outcome!=='validated'&&q.outcome!=='contradicted') return; var w=Math.pow(0.9,ai++); wSum+=w; if(q.outcome==='validated') wVal+=w; });
    var assessed=val+con;
    var score = assessed ? Math.round(wVal/wSum*100)+'%' : '—';
    document.getElementById('fore-badge').innerHTML = badge('badge-secondary', recs.length+' recs');
    var rows=recs.slice(0,10).map(function(q){
      var o=q.outcome;
      var oc = o==='validated' ? '<span class="oc-val">✔ held up</span>'
             : o==='contradicted' ? '<span class="oc-con">✘ overturned</span>'
             : '<span class="muted">◦ pending</span>';
      var txt=q.recommendation||q.answer||q.question;
      var pt=q.priority?badge('badge-outline', esc(prioShort(q.priority))):'';
      return '<tr><td class="mono" style="white-space:nowrap">'+oc+'</td>'+
        '<td class="mono" style="color:hsl(var(--muted-foreground));white-space:nowrap">'+esc(nmeOnly(q.asker))+'</td>'+
        '<td class="trunc">'+esc(txt)+'</td>'+
        '<td style="white-space:nowrap">'+pt+'</td>'+
        '<td class="right mono">'+age(s.now,q.at)+'</td></tr>';
    }).join('');
    var table = recs.length
      ? '<table class="tbl"><thead><tr><th>outcome</th><th>from</th><th>recommendation</th><th>priority</th><th class="right">age</th></tr></thead><tbody>'+rows+'</tbody></table>'
      : '<div class="empty">no foreman recommendations yet</div>';
    document.getElementById('fore-body').innerHTML =
      '<div class="fore-top">'+
        '<span class="score'+(assessed?' has':'')+'">'+score+'</span>'+
        '<div class="tags">'+
          badge('badge-outline','<b class="oc-val">'+val+'</b>&nbsp;held up')+
          badge('badge-outline','<b class="oc-con">'+con+'</b>&nbsp;overturned')+
          badge('badge-secondary','<b>'+pend+'</b>&nbsp;not yet judged')+
        '</div>'+
      '</div>'+
      '<p class="card-desc" style="padding:0 0 12px">The foreman grades its own calls in hindsight — did each recommendation hold up, or did a later finding overturn it? '+
        'Score = held up ÷ (held up + overturned), recency-weighted. It measures the foreman\\'s judgment, not whether '+esc(PRINCIPAL)+' accepted its advice.'+
        (assessed?'':' Nothing judged yet — the score appears once the foreman starts introspecting on how its recommendations played out.')+'</p>'+
      table;
  }

  function render(s){
    var realColl=(s.collisions||[]).filter(function(c){
      var d=String(c.detail||'').toLowerCase();
      return d.indexOf('settings')<0 && d.indexOf('.bak')<0 && d.indexOf('.local')<0 && d.indexOf('.lock')<0;
    });

    // needs-you (escalations awaiting the principal)
    var qs=s.questions||[];
    var needs=qs.filter(function(q){return q.state==='needs_human';});
    document.getElementById('needs').innerHTML = needs.length
      ? '<div class="alert alert-warn">'+needs.map(function(q){
          var rec=q.recommendation?' <span class="muted">↳ '+esc(q.recommendation)+'</span>':'';
          return '<div class="alert-row">'+badge('badge-secondary', esc(nmeOnly(q.asker))+' needs you')+'<span class="q">'+esc(q.question)+rec+'</span></div>';
        }).join('')+'</div>'
      : '';

    var collide={}; realColl.forEach(function(c){ collide[c.a]=1; collide[c.b]=1; });

    var workers=[];
    s.agents.forEach(function(a){ if(wtNum(a.id)!=null) workers.push(a); });
    workers.sort(function(a,b){ return wtNum(a.id)-wtNum(b.id); });

    renderUtil(s, workers);
    renderWorkers(s, workers, collide);
    renderForeman(s);

    document.getElementById('collstrip').innerHTML = realColl.length
      ? '<div class="alert" style="border-color:hsl(var(--destructive) / 0.5)"><div class="muted mono" style="font-size:12px">⚠ collisions · same file open in two panes</div>'+
        realColl.map(function(c){
          var what=c.kind==='file'?esc(c.detail):('same ticket '+esc(c.detail));
          return '<div class="alert-row">'+badge('badge-destructive', esc(nmeOnly(c.a))+' & '+esc(nmeOnly(c.b)))+'<span class="q mono">'+what+'</span></div>';
        }).join('')+'</div>'
      : '';

    var others=s.agents.filter(function(a){ return wtNum(a.id)==null && a.id!=='foreman' && a.online; });
    document.getElementById('others').innerHTML = others.length
      ? '<div class="chips">'+others.map(function(a){
          return badge('badge-outline','<span class="dot" style="display:inline-block;width:7px;height:7px;border-radius:9999px;background:'+dotColor(a.state)+'"></span> '+esc(nmeOnly(a.id))+' <span class="muted">'+esc(a.branch||'—')+'</span>');
        }).join('')+'</div>'
      : '';
  }

  var fails=0;
  function tick(){
    fetch('/api/state',{cache:'no-store'}).then(function(r){return r.json();}).then(function(s){
      fails=0; document.getElementById('livetxt').textContent='live'; render(s);
    }).catch(function(){ fails++; if(fails>1) document.getElementById('livetxt').textContent='reconnecting…'; });
  }
  tick(); setInterval(tick,2000);
</script>
</body>
</html>`;
}
