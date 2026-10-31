(()=>{"use strict";
const F=typeof window!=="undefined"&&window.BoardFoley&&window.BoardFoley.x;if(!F)return;
const{S,G,ping,allow,hap,duck,later,keyNow,rebuild,Q,T,panOf,posOf,now,core,cl,W,miss}=F,{u,rung,ladderPlan}=core,P=F.P(),TAU=Math.PI*2,X={parts:[],glow:null,raf:0,cv:null,col:null,zi:null,jk:0};
function canvas(){if(X.cv)return X.cv;const D=W.document;if(!D||!D.createElement||!D.body)return null;const c=D.createElement("canvas");c.id="foley-fx";c.setAttribute("aria-hidden","true");c.style.cssText="position:fixed;left:0;top:0;pointer-events:none;z-index:60";D.body.appendChild(c);X.cv=c;
X.col=T(()=>{const cs=W.getComputedStyle(D.documentElement);return P.fx.tokens.map(t=>cs.getPropertyValue(t).trim()||cs.color)})||["currentColor","currentColor"];return c}
function burst(el,units,x,o){o=o||{};const g=G(),l=T(()=>S.I.ctx.outputLatency*1e3)||0;if(!g.visual||!canvas())return 0;if(l>40&&!o.late){later(()=>burst(el,units,x,{...o,late:1}),l);return 0}const w=W.innerWidth||1e3,f=P.fx,pc=particleCount(units*(g.half?.5:1),w),cap=w<f.widths[0]?f.phoneLive:f.live,p=posOf(el);
for(let i=0;i<pc.n&&X.parts.length<cap;i++)X.parts.push({x:p.x,y:p.y,a:(o.ring?i/pc.n:-.5+i*.37)*TAU,v:f.speed[0]+f.speed[1]*cl(x||0,0,1),t:now(),c:i%2});
if(o.glow)X.glow={x:p.x,y:p.y,t:now()};if(!X.raf&&(X.parts.length||X.glow))X.raf=W.requestAnimationFrame(frame);return pc.n}
function frame(){X.raf=0;const cv=X.cv,c=cv&&cv.getContext&&cv.getContext("2d"),t=now(),f=P.fx;if(!c){X.parts.length=0;X.glow=null;return}
if(cv.width!==W.innerWidth||cv.height!==W.innerHeight){cv.width=W.innerWidth;cv.height=W.innerHeight}c.clearRect(0,0,cv.width,cv.height);X.parts=X.parts.filter(p=>t-p.t<f.life);
for(const p of X.parts){const k=(t-p.t)/f.life,d=p.v*(t-p.t)/1e3;c.globalAlpha=.9*(1-k)*(1-k);c.fillStyle=X.col[p.c];c.fillRect(p.x+Math.cos(p.a)*d-2,p.y+Math.sin(p.a)*d-2,4,4)}
const g=X.glow;if(g){const k=(t-g.t)/f.glowMs;if(k>=1)X.glow=null;else{const r=f.glow/2,gr=c.createRadialGradient(g.x,g.y,0,g.x,g.y,r);gr.addColorStop(0,X.col[0]);gr.addColorStop(1,"transparent");c.globalAlpha=f.glowA*(1-k)*(1-k);c.fillStyle=gr;c.fillRect(g.x-r,g.y-r,f.glow,f.glow)}}
if(X.parts.length||X.glow)X.raf=W.requestAnimationFrame(frame)}
function buffRun(k,el){const D=P.drivers.buffs,n=Math.min(k,D.cap);if(!S.B||!G().audio||n<1||!allow(Array.from({length:n},(_,i)=>i*D.gap)))return 0;for(let i=0;i<n;i++)ping("bell",Math.round(i*10/Math.max(1,D.cap-1)),i===n-1?1:null,{free:1,delay:i*D.gap,pan:panOf(el),noFat:1});hap("step");burst(el,n,k/D.hi);return 1}
function zoomTo(f){const D=P.drivers.zoom,i=Math.round(Math.log(f)/Math.log(D.step)),p=X.zi;if(p===i)return 0;X.zi=i;if(p==null||!G().audio)return 0;if(i%3===0)hap("tick");return ping("tick",((i%2)+2)%2,null,{noFat:1})}
function swing(s){const R=ribbon(s),t=now();if(!R.play||t-(X.rb||-1e9)<1e3/P.drivers.ribbon.perSec||!G().audio||!allow(1))return 0;X.rb=t;return T(()=>W.BoardSound.play("tab",{db:R.db}))?1:0}
function particleCount(n,w){const F=P.fx,cap=F.caps[w<F.widths[0]?0:w<F.widths[1]?1:2],s=n>cap?Math.ceil(n/cap):1;return{n:Math.min(cap,Math.max(0,Math.round(n))),step:s,label:s>1?"x"+s:"",cap}}
const ribbon=s=>{const R=P.drivers.ribbon,k=cl(s/R.max,0,1);return{play:s>=R.min,db:R.dbLo+(R.dbHi-R.dbLo)*k,cut:R.cutLo+(R.cutHi-R.cutLo)*k}};
const clockRung=left=>{const C=P.drivers.clock;let r=-1;C.at.forEach((t,i)=>{if(left<=t)r=C.rungs[i]});return r};
Object.assign(core,{particleCount,ribbon,clockRung,layers:x=>(x>=.25)+(x>=.5)+(x>=.75),lmix:x=>P.layerAt.reduce((s,t)=>s+cl((x-t)/P.fade,0,1),0)});
const rnd=core.lcg(7);
function askKey(){const D=P.drivers.ask,t=now();if(!S.B||!G().audio||t-(X.ak||-1e9)<1e3/D.perSec)return 0;X.ak=t;return ping("tick",rnd()<.5?0:1,null,{noFat:1})}
function askReply(){const D=P.drivers.ask;if(!S.B||!G().audio||!allow([0,D.replyGap]))return 0;D.reply.forEach((r,i)=>ping("bell",r,null,{free:1,delay:i*D.replyGap,noFat:1}));hap("tick");return 1}
function jstep(k,n,el){const x=k/n;if(k>=n){const pp=core.payoffPlan(1,10,S.pay,now(),false);if(pp)payoff(pp,panOf(el),el);burst(el,8,1,{ring:1});hap("full")}else{ping("bell",core.rung(x),x,{pan:panOf(el),noFat:1});burst(el,1,x);hap("cross")}return 1}
function payoffPlan(n,p,st,t,remote){if(remote||n<1)return null;st.pay=(st.pay||[]).filter(x=>t-x<6e4);if(t-(st.pt==null?-1e9:st.pt)<P.gov.payGap||st.pay.length>=P.gov.payPerMin)return null;
const k=Math.min(P.lead.cap,n),lead=[],L=P.level;let at=0;P.lead.gaps.slice(3-k).forEach((g,j)=>{at+=g;lead.push({t:at,r:Math.max(0,p-(k-j))})});const pt=at+P.lead.after;st.pt=t;st.pay.push(t);
return{lead,pay:{t:pt,chord:[p,Math.min(10,p+L.octaveRung),Math.min(10,p+L.fifthRung)].map((r,i)=>({dt:P.lead.chord[i],r}))},total:pt}}
const ladderSt=id=>S.pl[id]||(S.pl[id]={r:-1,t:-1e9,on:[]});
function payoff(pp,pan,el){const ct=pp.pay.chord,B=S.B;if(!B||!G().audio||!allow([...pp.lead.map(l=>l.t),...ct.map(c=>pp.pay.t+c.dt)]))return 0;
for(const l of pp.lead)ping("pluck",l.r,null,{free:1,noFat:1,delay:l.t,pan});ct.forEach(c=>ping("bell",c.r,null,{free:1,noFat:1,delay:pp.pay.t+c.dt,db:B.pg[ct[0].r],pan,send:P.bus.verbPayoff}));
duck(P.duck.payDb,P.duck.payMs);later(()=>burst(el,12,1,{ring:1,glow:1}),pp.pay.t);return 1}
function step(id,v,o){const d=P.drivers[id],x=u(v,o.lo,o.hi,d.curve),pl=ladderPlan(ladderSt(id),rung(x),now());if(!pl)return 0;
const ok=ping("bell",pl.r,x,{dir:pl.dir,pan:panOf(o.el)});if(ok){S.hist.push(now());duck(P.duck.ladderDb,P.duck.hold)}hap("step");burst(o.el,Math.abs(o.units!=null?o.units:1),x);return ok}
function climb(id,v,o){o=o||{};const d=P.drivers[id];o.lo=o.lo!=null?o.lo:d.lo;o.hi=o.hi!=null?o.hi:d.hi;const prev=S.last[id];S.last[id]=v;
if(prev==null||v===prev||!(o.direct==null?now()-S.inp<800:o.direct))return 0;const x=u(v,o.lo,o.hi,d.curve),t=now(),cr=(o.thr||[]).filter(c=>prev<c&&c<=v),st=ladderSt(id);
if(t-st.t>P.gov.idle&&S.sess<t-P.gov.idle){S.sess=t;if(S.B&&!S.bld&&keyNow()!==S.m0&&G().audio){S.bld=1;rebuild(keyNow())}}
let ok=0;if(v>prev&&cr.length){const pp=payoffPlan(cr.length,rung(u(cr[cr.length-1],o.lo,o.hi,d.curve)),S.pay,t,false);if(pp&&payoff(pp,panOf(o.el),o.el)){ok=1;st.r=rung(x);st.t=t;hap("cross")}}
if(!ok){ok=step(id,v,o);if(!ok&&!S.pend){S.pend=1;later(()=>{S.pend=0;step(id,S.last[id],o)},P.gov.minGap+5)}}
if(x>=1)hap("full");else if(x<=0)hap("edge");return ok}
Object.assign(core,{payoffPlan});
function tally(n,own){const D=P.drivers.tally,p=X.tally;X.tally=n;if(p==null||n<=p||!G().audio)return 0;const r=D.rungs[cl(n,1,D.max)-1],el=Q('.su-num[data-land="signups.in"]');
if(!own)return now()-S.inp<2e3?0:ping("bell",r,null,{db:P.level.remote,pan:panOf(el),noFat:1});hap("cross");burst(el,n,n/D.max);
if(n>=D.max){const pp=core.payoffPlan(1,r,S.pay,now(),false);if(pp&&payoff(pp,panOf(el),el)){hap("full");T(()=>W.BoardSound.play("cheer",{db:P.level.cheer}));return 1}}return ping("bell",r,null,{pan:panOf(el)})}
function clockBeat(L){const D=P.drivers.clock,left=L!=null?L:Math.ceil((Date.parse(D.launch)-Date.now())/1e3),prev=X.left;X.left=left;const el=Q("#clock-digits");if(!el){miss("clock");return}
if(prev==null||left>=prev||el.offsetParent===null)return;const pan=panOf(el);
if(left<=0&&prev>0){const pp=core.payoffPlan(1,10,S.pay,now(),false);if(pp)payoff(pp,pan,el);burst(el,40,1,{ring:1,glow:1});return}
if(left>=1&&left<=D.last){ping("pluck",10-left,null,{pan,noFat:1});hap("tick");return}const i=D.at.findIndex(t=>t>0&&prev>t&&left<=t);if(i>=0){ping("bell",D.rungs[i],null,{pan,noFat:1});hap("cross")}}
function onInput(e){const t=e&&e.target;if(!t||!t.closest)return;
if(e.type==="input"&&t.id==="deep-level")climb("level",+t.value,{lo:+t.min,hi:+t.max,el:t,direct:true});
else if(e.type==="click"&&t.closest("#buffs-deep .deep-marks button")){const sl=Q("#deep-level");if(sl)later(()=>{climb("level",+sl.value,{lo:+sl.min,hi:+sl.max,el:sl,direct:true});ping("bell",core.rung(core.u(+sl.value,+sl.min,+sl.max,"lin")),null,{db:-3,pan:panOf(sl),noFat:1});hap("cross")},0)}
else if(e.type==="keydown"&&t.id==="ch-text"&&!e.repeat&&!Q(".hades:not(.is-still):not([hidden])"))askKey();
else if(e.type==="click"&&t.closest("#nx-card")){const a=(Q("#nx-t")||{}).textContent,n=P.drivers.journey.n;later(()=>{const h=Q("#nx-t");if(h&&h.textContent!==a){X.jk=Math.min(n,X.jk+1);jstep(X.jk,n,h)}},400)}
else if(e.type==="pointermove"&&t.closest("#tabs")){const dt=Math.max(1,now()-(X.pt||0)),d=Math.hypot(e.clientX-(X.px||e.clientX),e.clientY-(X.py||e.clientY));X.px=e.clientX;X.py=e.clientY;X.pt=now();if(dt<200)swing(d/dt*1e3)}
if(W.__atlas&&(e.type==="wheel"||e.type==="pointerup"||e.type==="keydown"))later(()=>{const s=W.__atlas.status();if(s.on){const z=s.zoom!=null?s.zoom:s.z;if(typeof z==="number")zoomTo(Math.pow(2,z));else miss("zoom")}},60)}
const D=W.document;
if(D&&D.addEventListener){for(const ev of["keydown","click","input","wheel","pointerup","pointermove"])D.addEventListener(ev,e=>T(()=>onInput(e)),{capture:true,passive:true});
T(()=>W.__boardKit.on("signups",()=>{const b=Q('.su-num[data-land="signups.in"] b'),n=b?+b.textContent:NaN;if(isFinite(n))tally(n,now()-S.inp<2500)}));
D.addEventListener("pointerover",e=>{const li=e.target&&e.target.closest&&e.target.closest("li.bq[data-key]");if(!li)return;clearTimeout(X.bt);X.bt=later(()=>{const s=W.__buffsFx&&W.__buffsFx.status(),k=s&&(typeof s.hot==="number"?s.hot:s.parts);if(typeof k==="number")buffRun(k,li);else miss("buffs")},250)},{capture:true,passive:true});
T(()=>{const lv=Q("#ch-live");if(lv&&W.MutationObserver)new W.MutationObserver(()=>{if(lv.textContent)askReply()}).observe(lv,{childList:true,characterData:true,subtree:true})})}
function hookDial(){const K=W.__boardKit;if(!K)return;if(!K.dial){miss("dial");return}if(K.dialHook===X.hook)return;const p=K.dialHook;X.hook=(v,g,t)=>{if(p)p(v,g,t);T(()=>{const th=[];for(const l of W.document.querySelectorAll("li[data-n]")){const n=+l.getAttribute("data-n");if(isFinite(n))th.push(n)}climb("dial",v,{hi:K.dial.total,thr:th,el:Q(".dial[role=slider]")})})};K.dialHook=X.hook}
hookDial();
F.jin({hook:hookDial,burst,beat:()=>clockBeat(),count:()=>X.parts.length,stop:()=>{X.parts.length=0;X.glow=null;X.raf=0;clearTimeout(X.bt)},
drive:(id,v,o)=>{if(id==="tally")tally(v,o.direct!==false);else if(id==="clock"){X.left=o.prev!=null?o.prev:X.left;clockBeat(v)}else if(id==="level"||id==="dial")climb(id,v,o);else if(id==="buffs")buffRun(v,o.el);else if(id==="zoom")zoomTo(v);else if(id==="ribbon")swing(v);else if(id==="ask")o.reply?askReply():askKey();else if(id==="journey")jstep(v,P.drivers.journey.n,o.el)}});
})();
