(()=>{"use strict";
const W=typeof window!=="undefined"?window:globalThis,TAU=Math.PI*2,DB=d=>Math.pow(10,d/20),LG=Math.log10,cl=(x,a,b)=>Math.min(b,Math.max(a,x)),T=f=>{try{return f()}catch(e){}};
const lcg=s=>{let a=(s>>>0)||1;return()=>((a=(Math.imul(a,1664525)+1013904223)>>>0)/4294967296)};
let P=null;
const u=(v,lo,hi,c)=>!(hi>lo)?0:c==="log"?(v>0&&lo>0?cl(Math.log(v/lo)/Math.log(hi/lo),0,1):0):cl((v-lo)/(hi-lo),0,1);
const rung=x=>Math.round(x*10);
const tonic=m=>{let k=+((String(m||"").match(/(\d+)\s*$/)||[])[1])||P.midi.def;while(k<P.midi.min)k+=12;while(k>P.midi.min+11)k-=12;return k};
const semi=r=>P.scale[r%5]+12*Math.floor(r/5),freq=(m,r)=>440*Math.pow(2,(m+semi(r)-69)/12);
function ladderPlan(st,r,t){if(t-st.t>P.gov.idle)st.r=-1;if(r===st.r)return null;st.on=st.on.filter(x=>t-x<1000);if(st.r>=0&&(t-st.t<P.gov.minGap||st.on.length>=P.gov.perSec))return null;const dir=st.r<0||r>st.r?1:-1;st.r=r;st.t=t;st.on.push(t);return{r,dir}}
const gates=e=>{const q=!!(e.play||e.calm||e.reduced),b=!!e.on&&!e.off&&!e.hidden;return{audio:b&&!e.calm&&(!!e.explicit||!q),haptic:b&&!q&&!e.lowBattery,visual:b&&!q&&!e.still&&e.tier!=="off"&&e.tier!=="low",half:!!(e.saveData||e.lowBattery)}};
const fatigue=(h,now)=>{const F=P.fatigue,b=new Set;for(const x of h)if(now-x<F.win&&x<=now)b.add(Math.floor(x/1000));return b.size>=F.b?-F.dbB:b.size>=F.a?-F.dbA:0};
const panFor=(x,w)=>cl(x/w*2-1,-1,1)*P.pan.max[w<P.pan.widths[0]?0:w<P.pan.widths[1]?1:2];
function renderNote(kind,f,sr,seed){const Q=P.timbre[kind],n=Math.round(Q.len*sr),y=new Float32Array(n),R=lcg(seed),fr=f*(Q.mul||1),a=Math.max(1,Math.round(Q.atk*sr)),tl=Math.round(.01*sr),tau=Q.tau*sr,kl=Q.lo?Math.exp(-TAU*Q.lo/sr):0,kh=Q.hi?Math.exp(-TAU*Q.hi/sr):0,kp=Q.lp?Math.exp(-TAU*Q.lp/sr):0;let l=0,h=0,p=0,pk=0;
for(let i=0;i<n;i++){let v=0;if(Q.noise){const x=R()*2-1;l=kl*l+(1-kl)*x;h=kh*h+(1-kh)*(x-l);v=h}else{for(let j=0;j<Q.p.length;j++)if(fr*Q.p[j]<sr*.45)v+=Q.w[j]*Math.sin(TAU*fr*Q.p[j]*i/sr);if(kp){p=kp*p+(1-kp)*v;v=p}}
v*=(i<a?i/a:Math.exp(-(i-a)/tau))*(i>n-tl?(n-i)/tl:1);y[i]=v;pk=Math.max(pk,Math.abs(v))}
const g=DB(Q.db)/(pk||1);for(let i=0;i<n;i++)y[i]*=g;return y}
const dtau=()=>P.timbre.bell.tau/(1/P.descent.decay-1);
const core={init:p=>{P=p},u,rung,tonic,semi,freq,ladderPlan,gates,fatigue,panFor,renderNote,dtau,lcg};
const S={off:0,explicit:0,B:null,bus:null,I:null,voices:[],onsets:[],hist:[],pay:{},pl:{},last:{},T:new Set,miss:[],low:0,inp:-1e9,m0:0,bld:0,clk:0,wired:0,sess:-1e9,n:0,fx:null};
const now=()=>W.performance?W.performance.now():0,Q=s=>T(()=>W.document.querySelector(s)),later=(f,ms)=>{const id=setTimeout(()=>{S.T.delete(id);T(f)},ms);S.T.add(id);return id},miss=n=>{if(!S.miss.includes(n))S.miss.push(n)};
function env(){const D=W.document,H=D&&D.documentElement,c=n=>!!(H&&H.classList&&H.classList.contains(n)),SB=W.BoardSound;let still=c("still"),red=0,I=null,on=0;
T(()=>{still=still||W.localStorage.getItem("board-still")==="1"});T(()=>{red=W.matchMedia("(prefers-reduced-motion: reduce)").matches});T(()=>{I=SB.internals();on=!!(SB.status().on&&I&&I.ctx.state==="running")});
return{on,off:S.off,explicit:S.explicit,play:c("play"),calm:c("calm"),still,reduced:red,hidden:!!(D&&D.hidden),saveData:!!(W.navigator&&W.navigator.connection&&W.navigator.connection.saveData),lowBattery:S.low,tier:c("room-off")?"off":"on"}}
const G=()=>gates(env()),keyNow=()=>tonic(T(()=>W.BoardSensory.status().mode));
function arm(){if(S.B||S.bld||!P||!G().audio)return;const I=T(()=>W.BoardSound.internals());if(!I||I.ctx.state!=="running")return;S.I=I;S.bld=1;rebuild(keyNow())}
function rebuild(m0){const g=P.g[m0]||P.g[P.g.def],o={bell:[],pluck:[],spark:[],air:[],fifth:[],tick:[]},st=[];let i=0;
const mk=(k,t,r,sd,gd)=>{const b=renderNote(t,freq(m0,r),48000,sd),a=DB(gd);for(let j=0;j<b.length;j++)b[j]*=a;o[k][r]=b};
for(let r=0;r<11;r++){st.push(()=>{mk("bell","bell",r,11+r,g.b[r]);mk("pluck","pluck",r,31+r,g.p[r])});st.push(()=>{mk("spark","sparkle",r,51+r,g.s[r]);mk("air","air",r,71+r,g.a[r]);mk("fifth","fifth",r,91+r,g.f[r])})}
st.push(()=>P.tick.freq.forEach((f,k)=>{const b=renderNote("tick",f,48000,5+k),a=DB(g.t[k]);for(let j=0;j<b.length;j++)b[j]*=a;o.tick[k]=b}));
const go=()=>{const t0=now();while(i<st.length&&now()-t0<6)st[i++]();if(i<st.length){later(go,0);return}finish(o,m0,g);S.bld=0};later(go,0)}
function finish(o,m0,g){const c=S.I.ctx,ab=a=>{const b=c.createBuffer(1,a.length,48000);if(b.copyToChannel)b.copyToChannel(a,0);else b.getChannelData(0).set(a);return b},B={m0,pg:g.c,dg:g.d};
for(const k in o)B[k]=o[k].map(ab);
if(!S.bus){const b=P.bus,k=c.createDynamicsCompressor(),n=c.createGain();n.gain.value=DB(b.trim);k.threshold.value=b.thr;k.knee.value=b.knee;k.ratio.value=b.ratio;k.attack.value=b.atk;k.release.value=b.rel;n.connect(k);k.connect(S.I.ui);S.bus=n}S.B=B;S.m0=m0}
function allow(d){const t=now(),c=(Array.isArray(d)?d:Array(d).fill(0)).map(v=>t+v);S.onsets=S.onsets.filter(v=>v>t-1100);const all=S.onsets.concat(c);
for(const a of c)for(const s of all)if(s<=a&&s>a-1100&&all.filter(v=>v>=s&&v<s+1050).length>P.gov.global)return 0;
for(const v of c)if(W.BoardSound&&W.BoardSound.gate&&!W.BoardSound.gate())return 0;S.onsets.push(...c);S.n+=c.length;return 1}
const duck=(db,ms)=>T(()=>W.BoardSound.duckHold&&W.BoardSound.duckHold(db,ms)),hap=k=>T(()=>{if(W.BoardHaptics&&G().haptic)W.BoardHaptics.fire(P.haptic[k]||k)});
function note(parts,db,delay,o){const c=S.I.ctx,t=c.currentTime+.02+delay/1000,g=c.createGain();o=o||{};
while(S.voices.length>=P.gov.voices){const v=S.voices.shift();T(()=>v.stop())}
g.gain.setValueAtTime(DB(db),t);if(o.dec)g.gain.setTargetAtTime(1e-4,t,o.dec);let tail=g;if(c.createStereoPanner){const p=c.createStereoPanner();p.pan.value=o.pan||0;g.connect(p);tail=p}
tail.connect(S.bus);let sg=null;if(o.send!=null&&S.I.verbIn){sg=c.createGain();sg.gain.value=DB(o.send);tail.connect(sg);sg.connect(S.I.verbIn)}
parts.forEach(([b,d],i)=>{const s=c.createBufferSource(),a=c.createGain();s.buffer=b;a.gain.value=DB(d);s.connect(a);a.connect(g);s.start(t);
s.onended=()=>{T(()=>{a.disconnect();if(i)return;const k=S.voices.indexOf(s);if(k>=0)S.voices.splice(k,1);g.disconnect();tail.disconnect();if(sg)sg.disconnect()})};if(!i)S.voices.push(s)});return 1}
const posOf=el=>T(()=>{const r=el.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})||{x:(W.innerWidth||1e3)/2,y:(W.innerHeight||600)/2},panOf=el=>el&&W.innerWidth?panFor(posOf(el).x,W.innerWidth):0;
function ping(kind,r,x,o){o=o||{};if(!S.B||!G().audio||(!o.free&&!allow([o.delay||0])))return 0;const B=S.B,dn=o.dir===-1,parts=[[B[kind][r],0]];
if(kind==="bell"&&x!=null&&!dn)P.layerAt.forEach((t,j)=>{const f=cl((x-t)/P.fade,0,1);if(f>.05)parts.push([B[["spark","air","fifth"][j]][r],20*LG(f)])});
return note(parts,(o.db||0)+(o.noFat?0:fatigue(S.hist,now()))+(dn?P.level.descent+B.dg[r]:0),o.delay||0,{pan:o.pan,send:o.send,dec:dn?dtau():0})}
function wire(){const D=W.document;if(!D||!D.addEventListener)return;
if(!S.wired){S.wired=1;for(const ev of["pointerdown","keydown","input","click","pointermove"])D.addEventListener(ev,e=>{if(ev!=="pointermove"||e.buttons)S.inp=now()},{capture:true,passive:true});
D.addEventListener("visibilitychange",refresh);W.addEventListener("board-mode",refresh);
T(()=>W.navigator.getBattery().then(b=>{S.low=b.level<=.2&&!b.charging?1:0},()=>{}))}
if(S.fx)S.fx.hook()}
function refresh(){const g=G(),open=g.audio||g.visual||g.haptic;if(open&&!S.clk)S.clk=setInterval(()=>S.fx&&S.fx.beat(),1e3);else if(!open&&S.clk){clearInterval(S.clk);S.clk=0}arm()}
function stop(){for(const id of S.T)clearTimeout(id);S.T.clear();if(S.clk)clearInterval(S.clk);S.clk=0;S.voices.length=0;if(S.fx)S.fx.stop()}
function set(on,explicit){S.off=on?0:1;S.explicit=on&&explicit?1:0;if(explicit!==undefined)T(()=>W.localStorage.setItem("board-foley",on?"1":"0"));if(on)refresh();else stop()}
function drive(id,v,o){if(!P)return false;if(!S.B){arm();if(!S.B)return false}o=o||{};const n0=S.n;
if(S.fx)S.fx.drive(id,v,o);return S.n!==n0}
const status=()=>{const t=now();return{built:!!S.B,gates:G(),onsets60s:S.hist.filter(x=>t-x<6e4).length,voices:S.voices.length,tonic:S.m0,missing:S.miss.slice(),timers:S.T.size+(S.clk?1:0),parts:S.fx?S.fx.count():0}};
function boot(p){P=p;T(()=>{const v=W.localStorage.getItem("board-foley");S.off=v==="0"?1:0;S.explicit=v==="1"?1:0});wire();const K=W.__boardKit;if(K&&K.on)for(const n of["scene","rendered"])K.on(n,wire);T(()=>W.BoardSound.onState(()=>later(refresh,0)));T(()=>W.__scenes.load("foleyfx"));refresh()}
W.BoardFoley={core,status,set,drive,stop,refresh,boot,x:{P:()=>P,S,G,ping,allow,hap,duck,later,keyNow,rebuild,Q,T,panOf,posOf,now,core,cl,W,miss,jin:n=>{S.fx=n}}};
if(typeof document!=="undefined"&&document.currentScript&&document.currentScript.src)fetch(new URL("../data/foley.json",document.currentScript.src)).then(r=>r.json()).then(boot,()=>{});
})();
