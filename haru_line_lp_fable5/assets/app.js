/* =========================================================
   BAKU LINE LP — interactions
   ========================================================= */

/* ===== 朝／夜の切り替え（ヘッダー左のスイッチ） =====
   <html data-theme="morning"> が付くと、CSS側の配色と背景の水面が朝になります。
   選んだほうは localStorage に覚えるので、次に開いたときも同じ側で始まります。
   （最初の一瞬だけ夜が見えるのを防ぐため、読み込みは index.html の <head> でやっています） */
(function(){
  var btn=document.getElementById('themeToggle');
  if(!btn)return;
  var state=btn.querySelector('.tg-state');
  function apply(morning,save){
    document.documentElement.dataset.theme = morning ? 'morning' : 'night';
    btn.classList.toggle('on',morning);
    btn.setAttribute('aria-pressed',morning?'true':'false');
    if(state)state.textContent = morning ? '朝' : '夜';
    // スマホのブラウザ上部の色も、水面に合わせる
    var tc=document.querySelector('meta[name="theme-color"]');
    if(tc)tc.setAttribute('content',morning?'#bfe7f8':'#04080c');
    // 水面の色を差し替える（water の IIFE が用意する）
    if(window.__water && window.__water.setTheme) window.__water.setTheme(morning?'morning':'night');
    if(save){ try{ localStorage.setItem('baku-theme', morning?'morning':'night'); }catch(e){} }
  }
  apply(document.documentElement.dataset.theme==='morning',false);
  btn.addEventListener('click',function(e){
    e.stopPropagation();
    apply(document.documentElement.dataset.theme!=='morning',true);
  });
})();

/* =========================================================
   WATER SURFACE — cinematic moonlit ripple
   - height-field wave sim
   - raindrop impact profile (crater + expanding rim) → real concentric rings
   - perspective-squashed ripples → a surface seen at an angle, not from above
   - absorbing borders → waves leave the frame instead of bouncing like a tank
   - bilinear (sub-pixel) refraction  → no blocky edges
   - moon-directional specular + crest sparkle + chromatic dispersion
   - shimmering moonlight reflection column
   - refracted starfield baked into the background
   Extras (神秘的な演出):
   - drifting luminous motes that touch the water & ripple it
   - glowing rings that bloom where you tap
   - occasional shooting star that splashes into the surface
   tap = ripple + optional water-drop sound (癒しスイッチ)
   ========================================================= */
(function(){
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const lowPower = matchMedia('(max-width:600px)').matches;
  const cv = document.getElementById('water');
  if(!cv) return;
  const ctx = cv.getContext('2d', { alpha:false });
  ctx.imageSmoothingEnabled = true;

  const sim = document.createElement('canvas');
  const sctx = sim.getContext('2d');

  let W,H,cols,rows,cur,prev,frame,bgData;
  let glare;                 // precomputed moonlight-column intensity (per cell)
  let ldx,ldy;               // precomputed unit vector toward the moon (per cell)
  let damp;                  // per-cell damping — absorbs waves at the frame edge
  let mcx,mcy;               // moon centre in sim coords
  let scaleBase;             // current downscale factor (raised if a device is slow)

  const DAMP    = 0.982;     // long-lived, calm ripples
  const REFRACT = 0.95;      // light-bending strength (bilinear → can push higher)
  const SPEC    = 7.5;       // moon-facing glint
  const FOAM    = 0.18;      // white sparkle on wave crests
  const CHROMA  = 1.3;       // prismatic edge dispersion
  const SQUASH  = 0.66;      // 水面を斜めから見た遠近 — 波紋は縦につぶれた楕円に広がる
  /* 波の伝わる速さを縦方向だけ遅くする（速さの比 = SQUASH）。
     こうしないと最初だけ楕円で、広がるうちに真円に戻ってしまう。
     WX+WY=1 を保てば元のスキームと同じ安定性。 */
  const WY = 1/(1+1/(SQUASH*SQUASH)), WX = 1-WY;

  /* ---- 夜と朝の2枚のパレット ----------------------------------------
     波のシミュレーション自体は共通で、色だけを差し替えています。
     grad … 上から下への水の色（4段）      star … 水面に映る光の粒
     halo … 空にある光の輪（夜=月／朝=太陽） core … その中心の芯
     ring … 画面をタップしたときに広がる輪  mote … ただよう光の粒 */
  const PALETTES={
    night:{
      grad:['#0d323d','#0a2029','#08141b','#04080c'],
      star:'226,240,242',
      halo:['rgba(214,236,238,.52)','rgba(159,184,189,.18)','rgba(159,184,189,0)'],
      core:'rgba(255,255,255,.92)',
      ring:'214,236,238',
      mote:['233,224,190','176,205,208']
    },
    morning:{
      grad:['#d8f2fd','#a5ddf6','#6ec4ea','#3ea3db'],
      star:'255,255,255',
      halo:['rgba(255,255,255,.62)','rgba(214,240,252,.26)','rgba(214,240,252,0)'],
      core:'rgba(255,255,255,.95)',
      ring:'255,255,255',
      mote:['255,255,255','206,238,252']
    }
  };
  let PAL = PALETTES[document.documentElement.dataset.theme==='morning'?'morning':'night'];

  function buildBG(){
    const off = document.createElement('canvas'); off.width=cols; off.height=rows;
    const o = off.getContext('2d');
    const g=o.createLinearGradient(0,0,0,rows);
    g.addColorStop(0,PAL.grad[0]); g.addColorStop(.30,PAL.grad[1]); g.addColorStop(.62,PAL.grad[2]); g.addColorStop(1,PAL.grad[3]);
    o.fillStyle=g; o.fillRect(0,0,cols,rows);
    // starfield (upper sky) — refracted by ripples for a living reflection
    const stars=Math.round((cols*rows)/900);
    for(let i=0;i<stars;i++){
      const sxp=Math.random()*cols, syp=Math.random()*rows*0.5;
      const a=0.25+Math.random()*0.6, rad=Math.random()<0.14?1.4:0.8;
      const sg=o.createRadialGradient(sxp,syp,0,sxp,syp,rad*2.2);
      sg.addColorStop(0,'rgba('+PAL.star+','+a+')'); sg.addColorStop(1,'rgba('+PAL.star+',0)');
      o.fillStyle=sg; o.fillRect(sxp-3,syp-3,6,6);
    }
    // moon halo + core
    mcx=cols*.5; mcy=rows*.13; const mr=Math.min(cols,rows)*.62;
    let mg=o.createRadialGradient(mcx,mcy,0,mcx,mcy,mr);
    mg.addColorStop(0,PAL.halo[0]); mg.addColorStop(.26,PAL.halo[1]); mg.addColorStop(1,PAL.halo[2]);
    o.fillStyle=mg; o.fillRect(0,0,cols,rows);
    let md=o.createRadialGradient(mcx,mcy,0,mcx,mcy,mr*.12);
    md.addColorStop(0,PAL.core); md.addColorStop(1,'rgba(255,255,255,0)');
    o.fillStyle=md; o.fillRect(0,0,cols,rows);
    bgData = o.getImageData(0,0,cols,rows).data;

    // moonlight reflection column (separable, cheap) — the shimmering "path"
    glare=new Float32Array(cols*rows);
    const wx=cols*0.11, upFall=rows*0.05, dnFall=rows*0.62, AMP=36;
    const gcol=new Float32Array(cols), grow=new Float32Array(rows);
    for(let x=0;x<cols;x++){ const dx=(x-mcx)/wx; gcol[x]=Math.exp(-dx*dx); }
    for(let y=0;y<rows;y++){ const dy=y-mcy; grow[y]=dy<0?Math.exp(-Math.pow(dy/upFall,2)):Math.exp(-Math.pow(dy/dnFall,2)); }
    for(let y=0;y<rows;y++){ const gr=grow[y]*AMP; for(let x=0;x<cols;x++){ glare[y*cols+x]=gcol[x]*gr; } }
    buildFields();
  }
  /* per-cell constants — computed once per resize so the hot loop stays cheap.
     ldx/ldy replace a per-pixel sqrt every frame; damp turns the canvas border
     into open water (waves leave) instead of a tank wall (waves bounce back). */
  function buildFields(){
    ldx=new Float32Array(cols*rows); ldy=new Float32Array(cols*rows);
    damp=new Float32Array(cols*rows);
    const bx=Math.max(4,Math.round(cols*.11)), by=Math.max(4,Math.round(rows*.11));
    for(let y=0;y<rows;y++){
      for(let x=0;x<cols;x++){
        const idx=y*cols+x;
        const lvx=mcx-x, lvy=mcy-y, inv=1/Math.sqrt(lvx*lvx+lvy*lvy+1);
        ldx[idx]=lvx*inv; ldy[idx]=lvy*inv;
        const e=Math.min(1,Math.min(Math.min(x,cols-1-x)/bx,Math.min(y,rows-1-y)/by));
        damp[idx]=DAMP*(.80+.20*e*e*(3-2*e));
      }
    }
  }
  function resize(){
    W=innerWidth; H=innerHeight;
    cv.style.width=W+'px'; cv.style.height=H+'px'; cv.width=W; cv.height=H;
    if(!scaleBase){ const target=lowPower?150:230; scaleBase=Math.max(2,Math.round(W/target)); }
    const scale=scaleBase;
    cols=Math.max(2,Math.floor(W/scale)); rows=Math.max(2,Math.floor(H/scale));
    sim.width=cols; sim.height=rows;
    cur=new Float32Array(cols*rows); prev=new Float32Array(cols*rows);
    frame=sctx.createImageData(cols,rows);
    buildBG();
  }
  /* 着水。soft=false は雨粒そのもの — 中心がへこみ、縁が輪になって広がる
     （ガウスの2階微分＝クレーター＋リング）。soft=true は風のうねり用の緩い盛り上がり。
     どちらも SQUASH で縦につぶした楕円にして、斜めから見た水面に見せる。 */
  function drop(px,py,power,rad,soft){
    const cx=px/W*cols, cy=py/H*rows;
    const rx=rad||6, ry=Math.max(1.2,rx*SQUASH);
    const xa=Math.max(1,Math.floor(cx-rx)), xb=Math.min(cols-2,Math.ceil(cx+rx));
    const ya=Math.max(1,Math.floor(cy-ry)), yb=Math.min(rows-2,Math.ceil(cy+ry));
    for(let y=ya;y<=yb;y++){
      const dy=(y-cy)/ry, dy2=dy*dy, row=y*cols;
      for(let x=xa;x<=xb;x++){
        const dx=(x-cx)/rx, u2=dx*dx+dy2;
        if(u2>1.7)continue;
        if(soft) prev[row+x]+=power*Math.exp(-u2*1.6);
        else     prev[row+x]-=power*(1-4.8*u2)*Math.exp(-u2*2.4);
      }
    }
  }
  /* 跳ね返りの二次滴など、少し遅れて落ちる水滴 */
  const pending=[];
  function later(ms,x,y,power,rad,soft){ pending.push({t:performance.now()+ms,x:x,y:y,p:power,r:rad,s:soft}); }
  function flushPending(now){
    for(let i=pending.length-1;i>=0;i--){
      const d=pending[i];
      if(now>=d.t){ drop(d.x,d.y,d.p,d.r,d.s); pending.splice(i,1); }
    }
  }
  function step(){
    const c=cols;
    for(let y=1;y<rows-1;y++){ let idx=y*c+1;
      for(let x=1;x<c-1;x++,idx++){
        cur[idx]=((prev[idx-1]+prev[idx+1])*WX + (prev[idx-c]+prev[idx+c])*WY - cur[idx])*damp[idx];
      }
    }
    const t=prev; prev=cur; cur=t;
  }
  function render(){
    const out=frame.data, bg=bgData, c=cols, r=rows;
    out.set(bg);
    for(let y=1;y<r-1;y++){ let idx=y*c+1;
      for(let x=1;x<c-1;x++,idx++){
        const gx=prev[idx-1]-prev[idx+1], gy=prev[idx-c]-prev[idx+c];
        // ---- sub-pixel (bilinear) refraction ----
        let fx=x+gx*REFRACT, fy=y+gy*REFRACT;
        if(fx<0)fx=0; else if(fx>c-1.001)fx=c-1.001;
        if(fy<0)fy=0; else if(fy>r-1.001)fy=r-1.001;
        const x0=fx|0, y0=fy|0, tx=fx-x0, ty=fy-y0;
        const w00=(1-tx)*(1-ty), w10=tx*(1-ty), w01=(1-tx)*ty, w11=tx*ty;
        const i00=(y0*c+x0)<<2, i10=(y0*c+x0+1)<<2, i01=((y0+1)*c+x0)<<2, i11=((y0+1)*c+x0+1)<<2;
        let R=bg[i00]*w00+bg[i10]*w10+bg[i01]*w01+bg[i11]*w11;
        let G=bg[i00+1]*w00+bg[i10+1]*w10+bg[i01+1]*w01+bg[i11+1]*w11;
        let B=bg[i00+2]*w00+bg[i10+2]*w10+bg[i01+2]*w01+bg[i11+2]*w11;
        // ---- lighting ---- (light direction is precomputed: no sqrt in the hot loop)
        const ndl=gx*ldx[idx]+gy*ldy[idx];           // slope facing the moon
        const spec=ndl>0?ndl*SPEC:ndl*1.2;           // bright toward moon, soft shadow away
        const crest=(gx*gx+gy*gy)*FOAM;              // sparkle on ripple crests
        const gl=glare[idx]*(1+(ndl>0?ndl*0.12:0));  // moonlight column, shattering with waves
        const lum=spec+crest+gl;
        const chr=gx*CHROMA;                         // prismatic edges
        const d=idx<<2;
        out[d]=cl(R+lum+chr); out[d+1]=cl(G+lum); out[d+2]=cl(B+lum-chr+4);
      }
    }
    sctx.putImageData(frame,0,0);
    ctx.drawImage(sim,0,0,W,H);
  }
  function cl(v){return v<0?0:v>255?255:v;}

  /* ---- water drop sound: 3 local mp3s, preloaded pool ---- */
  const SRC=['assets/water_drop01.mp3','assets/water_drop02.mp3','assets/water_drop03.mp3'];
  const POOL=4;
  const pools=SRC.map(function(src){
    return Array.from({length:POOL},function(){
      const a=new Audio(src); a.preload='auto'; a.load(); return a;
    });
  });
  const cursor=[0,0,0];
  let soundOn=false;
  function plip(vol){
    if(!soundOn)return;
    const i=(Math.random()*pools.length)|0;
    const a=pools[i][cursor[i]++%POOL];
    try{ if(a.readyState>0)a.currentTime=0; }catch(e){}
    a.volume=vol;
    const p=a.play(); if(p&&p.catch)p.catch(function(){});
  }

  const sndBtn=document.getElementById('snd');
  if(sndBtn){
    const sndState=sndBtn.querySelector('.snd-state');
    sndBtn.addEventListener('click',function(e){
      e.stopPropagation();
      soundOn=!soundOn;
      sndBtn.classList.toggle('on',soundOn);
      sndBtn.setAttribute('aria-pressed',soundOn?'true':'false');
      if(sndState)sndState.textContent=soundOn?'ON':'OFF';
      if(soundOn)plip(.6);
    });
  }

  /* ===== overlay particles: motes / rings / shooting star ===== */
  const motes=[]; const rings=[];
  const MOTE_N = reduce?0:(lowPower?7:13);
  function newMote(top){
    return {x:Math.random()*W, y:top?-10:Math.random()*H,
      vy:0.12+Math.random()*0.32, sway:0.4+Math.random()*0.9, ph:Math.random()*6.28,
      rad:6+Math.random()*12, base:0.30+Math.random()*0.35, tw:0.6+Math.random()*1.6,
      next:performance.now()+800+Math.random()*2600};
  }
  function initMotes(){ motes.length=0; for(let i=0;i<MOTE_N;i++) motes.push(newMote(false)); }

  let star=null, nextStar=performance.now()+6000+Math.random()*8000;
  function spawnStar(){
    const fromL=Math.random()<0.5;
    const sx=fromL?-40:W+40, sy=H*(0.05+Math.random()*0.22);
    const ang=(fromL?1:-1)*(0.28+Math.random()*0.22);
    const sp=9+Math.random()*5;
    star={x:sx,y:sy,vx:Math.cos(ang)*sp*(fromL?1:-1),vy:Math.sin(ang)*sp,life:0,max:70+Math.random()*40};
  }

  function drawOverlay(now){
    // glowing tap rings — 水面の波紋と同じ楕円で、ゆっくり静かに開く
    if(rings.length){
      ctx.globalCompositeOperation='lighter';
      for(let i=rings.length-1;i>=0;i--){
        const rg=rings[i], age=now-rg.t-rg.d;
        if(age>1500){rings.splice(i,1);continue;}
        if(age<0)continue;
        const k=age/1500, ease=1-Math.pow(1-k,2.2);          // 開きはじめが速く、外へ行くほど緩む
        const rad=6+ease*Math.min(W,H)*0.34, a=Math.pow(1-k,1.8)*0.40*rg.a;
        ctx.strokeStyle='rgba('+PAL.ring+','+a+')'; ctx.lineWidth=1.6*(1-k)+0.35;
        ctx.beginPath(); ctx.ellipse(rg.x,rg.y,rad,rad*SQUASH,0,0,6.283); ctx.stroke();
      }
      ctx.globalCompositeOperation='source-over';
    }
    if(reduce) return;
    // drifting luminous motes
    ctx.globalCompositeOperation='lighter';
    for(const m of motes){
      m.y+=m.vy; m.x+=Math.sin(now*0.0006*m.sway+m.ph)*0.35;
      if(m.y>H+16){ Object.assign(m,newMote(true)); continue; }
      if(now>m.next){ drop(m.x,m.y,26,3.5); m.next=now+2200+Math.random()*3200; } // touch the water
      const a=m.base*(0.55+0.45*Math.sin(now*0.001*m.tw+m.ph));
      const g=ctx.createRadialGradient(m.x,m.y,0,m.x,m.y,m.rad);
      g.addColorStop(0,'rgba('+PAL.mote[0]+','+a+')');
      g.addColorStop(.45,'rgba('+PAL.mote[1]+','+(a*0.4)+')');
      g.addColorStop(1,'rgba('+PAL.mote[1]+',0)');
      ctx.fillStyle=g; ctx.beginPath(); ctx.arc(m.x,m.y,m.rad,0,6.283); ctx.fill();
    }
    // shooting star
    if(!star && now>nextStar){ spawnStar(); nextStar=now+14000+Math.random()*14000; }
    if(star){
      star.x+=star.vx; star.y+=star.vy; star.life++;
      const fade=Math.min(1,star.life/10)*Math.max(0,1-star.life/star.max);
      const tlx=star.x-star.vx*4, tly=star.y-star.vy*4;
      const grad=ctx.createLinearGradient(star.x,star.y,tlx,tly);
      grad.addColorStop(0,'rgba(255,255,255,'+(0.9*fade)+')');
      grad.addColorStop(1,'rgba(190,214,236,0)');
      ctx.strokeStyle=grad; ctx.lineWidth=2.1; ctx.lineCap='round';
      ctx.beginPath(); ctx.moveTo(star.x,star.y); ctx.lineTo(tlx,tly); ctx.stroke();
      const hg=ctx.createRadialGradient(star.x,star.y,0,star.x,star.y,7);
      hg.addColorStop(0,'rgba(255,255,255,'+fade+')'); hg.addColorStop(1,'rgba(255,255,255,0)');
      ctx.fillStyle=hg; ctx.beginPath(); ctx.arc(star.x,star.y,7,0,6.283); ctx.fill();
      if(star.life>=star.max || star.x<-60 || star.x>W+60 || star.y>H*0.6){
        if(star.y>0 && star.y<H){                                        // splash
          drop(star.x,star.y,230,9); later(300,star.x,star.y,70,4);
          rings.push({x:star.x,y:star.y,t:now,d:0,a:.8});
          plip(.5);
        }
        star=null;
      }
    }
    ctx.globalCompositeOperation='source-over';
  }

  /* ===== main loop with light perf auto-tune =====
     スマホは30fps上限。水はゆっくり動くので見た目はほぼ変わらず、
     計算量と発熱・電池消費が半分になる（＝リッチにしても軽い）。 */
  const FRAME_MS = reduce?50:(lowPower?32:16);
  const SUB = reduce?1:(lowPower?2:1);   // 描画を間引いても波の進む速さは変えない
  let lastF=0, lastAuto=0, lastSwell=0, workSum=0, workN=0, tuned=false;
  function loop(ts){
    requestAnimationFrame(loop);
    if(ts-lastF<FRAME_MS-1) return;
    lastF=ts;

    const t0=tuned?0:performance.now();
    flushPending(ts);
    for(let s=0;s<SUB;s++) step();
    render();
    try{ drawOverlay(ts); }catch(err){ /* particles must never halt the water */ }

    if(!reduce){
      // 遠くで魚が跳ねたような、たまの一滴
      if(ts-lastAuto>7000){
        lastAuto=ts+Math.random()*4000;
        drop(W*(.1+Math.random()*.8),H*(.12+Math.random()*.72),80,8);
      }
      // 風のうねり — 水面が完全に止まる瞬間をなくす（ほぼ無コスト）
      if(ts-lastSwell>1500){
        lastSwell=ts+Math.random()*1400;
        drop(W*Math.random(),H*(.1+Math.random()*.85),3+Math.random()*4,16+Math.random()*14,true);
      }
    }

    // one-time downscale if the device can't keep up (measures real work, not the frame cap)
    if(!tuned){
      workSum+=performance.now()-t0; workN++;
      if(workN===90){ if(workSum/90>15 && scaleBase<6){ scaleBase++; resize(); } tuned=true; }
    }
  }

  function pointer(e){
    // 3STEPを横スワイプしている指で、背後の水面に波紋を落とさない
    if(e.target&&(e.target.closest('#snd')||e.target.closest('.modal-card')||e.target.closest('.steps-track')||e.target.closest('a')||e.target.closest('button')))return;
    const t=e.touches?e.touches[0]:e;
    const x=t.clientX, y=t.clientY;
    if(reduce){ drop(x,y,150,6); plip(.45); return; }
    drop(x,y,340,7);                       // 着水
    later(240,x,y,105,4);                  // 跳ね返った二次滴が落ちる
    later(620,x,y,38,3);                   // さらに小さく、もう一度
    const now=performance.now();
    rings.push({x:x,y:y,t:now,d:0,a:1});
    rings.push({x:x,y:y,t:now,d:240,a:.55});
    plip(.9);
  }

  /* ヘッダーの朝／夜スイッチから呼ばれる。パレットを差し替えて背景を焼き直すだけで、
     波の状態（いま広がっている波紋）はそのまま残ります。 */
  window.__water={setTheme:function(name){
    const next=PALETTES[name]; if(!next||next===PAL)return;
    PAL=next; buildBG();
  }};

  addEventListener('resize',resize,{passive:true});
  addEventListener('pointerdown',pointer,{passive:true});
  resize();
  initMotes();                 // W/H are ready only after the first resize()
  setTimeout(function(){drop(W*.5,H*.42,reduce?130:270,8);later(280,W*.5,H*.42,80,4);},700);
  requestAnimationFrame(loop);
})();

/* =========================================================
   HERO PHRASES — 横から流れてくるコピー＋残り時間メーター
   数字の直後にメーターが入り、満ちたら次の言葉へ切り替わる。
   ヒーローが画面外にあるあいだは止めて、無駄に回さない。
   ========================================================= */
(function(){
  const slider=document.getElementById('heroSlider');
  const meter=document.getElementById('hsMeter');
  if(!slider||!meter)return;
  const phrases=Array.prototype.slice.call(slider.querySelectorAll('.hs-phrase'));
  if(!phrases.length)return;
  const reduce=matchMedia('(prefers-reduced-motion: reduce)').matches;
  const DUR=4800, STAGGER=38, OUT=520;

  // 禁則処理：span は folding の単位でもあるので、行頭にきてほしくない文字（、。ー など）は
  // 前の文字と、行末にきてほしくない文字（「（ など）は次の文字と、同じ span にまとめます。
  const NO_HEAD='、。，．・：；？！?!」』）］｝〉》〕”’ーぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ…‥〜～';
  const NO_TAIL='「『（［｛〈《〔“‘';
  function chunk(text){
    const out=[];
    Array.from(text).forEach(function(c){
      const last=out.length?out[out.length-1]:'';
      if(last&&(NO_HEAD.indexOf(c)>=0||NO_TAIL.indexOf(last.slice(-1))>=0)) out[out.length-1]=last+c;
      else out.push(c);
    });
    return out;
  }

  // 1文字ずつ span に分けて、流れ込むタイミングをずらす。
  // 文中の「|」は手で入れた改行位置。高さ0の要素を挟んで flex を折り返させる。
  phrases.forEach(function(p){
    const text=p.textContent.trim();
    p.textContent='';
    let n=0;                              // 遅延は「見た目の文字数」で数える
    chunk(text).forEach(function(part){
      if(part==='|'){
        const br=document.createElement('span');
        br.className='hs-br';
        p.appendChild(br);
        return;                           // 改行は文字数に数えない
      }
      const s=document.createElement('span');
      s.textContent=part;
      if(!reduce) s.style.animationDelay=(n*STAGGER)+'ms';
      n+=Array.from(part).length;
      p.appendChild(s);
    });
  });

  // メーターは1本のバーだけ。満ちたら次の言葉へ切り替わります。
  const track=document.createElement('span'); track.className='hs-track';
  const fill=document.createElement('i');     fill.className='hs-fill';
  track.appendChild(fill); meter.appendChild(track);
  meter.style.setProperty('--hs-dur',DUR+'ms');

  let cur=-1, timer=0, outTimer=0;
  function show(i){
    clearTimeout(timer);
    if(cur>=0 && cur!==i){
      const prev=phrases[cur];
      prev.classList.remove('is-on');
      prev.classList.add('is-out');
      clearTimeout(outTimer);
      outTimer=setTimeout(function(){prev.classList.remove('is-out');},OUT);
    }
    cur=i;
    const p=phrases[cur];
    p.classList.remove('is-out','is-on');
    void p.offsetWidth;                 // 頭から流し直す
    p.classList.add('is-on');
    fill.classList.remove('run'); void fill.offsetWidth; fill.classList.add('run');
    timer=setTimeout(function(){show((cur+1)%phrases.length);},DUR);
  }

  new IntersectionObserver(function(entries){
    if(entries[0].isIntersecting) show(cur<0?0:cur);
    else { clearTimeout(timer); fill.classList.remove('run'); }
  },{threshold:.2}).observe(slider);
})();

/* ===== reveal ===== */
(function(){
  const io=new IntersectionObserver((e)=>{e.forEach(t=>{if(t.isIntersecting){t.target.classList.add('in');io.unobserve(t.target);}})},{threshold:.14});
  document.querySelectorAll('.reveal').forEach(el=>io.observe(el));
})();

/* ===== sticky cta：表示制御＋セクション連動の文言切替 ===== */
(function(){
  const sticky=document.getElementById('sticky');
  const hero=document.querySelector('.hero');
  if(!sticky||!hero)return;

  // 追尾ボタンの表示/非表示（ヒーローを過ぎたら出す）
  new IntersectionObserver(([e])=>{sticky.classList.toggle('show',!e.isIntersecting&&e.boundingClientRect.top<0);},{threshold:0}).observe(hero);

  // スクロール位置（表示中セクション）に応じて文言を切替
  const ctaTextMap={
    top:'LINEで無料電話鑑定を受ける',
    profile:'この先生に無料の電話で相談してみる',
    worry:'今の悩みを無料の電話で相談する',
    voices:'無料の電話で相手の気持ちを占ってもらう',
    final:'LINE登録で無料電話鑑定を受ける'
  };
  const label=sticky.querySelector('.txt');
  if(!label)return;
  const io=new IntersectionObserver((entries)=>{
    entries.forEach((entry)=>{
      if(entry.isIntersecting){
        const t=ctaTextMap[entry.target.id];
        if(t)label.textContent=t;
      }
    });
  },{threshold:.5});
  Object.keys(ctaTextMap).forEach((id)=>{const el=document.getElementById(id);if(el)io.observe(el);});
})();

/* =========================================================
   ご利用の流れ — 3STEPの横スワイプ
   指の動きはブラウザの横スクロールに任せ、JSは「いま何枚目か」を
   読み取ってドットと矢印に反映するだけ。だから慣性も端の挙動もOS標準です。
   ========================================================= */
(function(){
  const track=document.getElementById('stepsTrack');
  const dots=document.getElementById('stepsDots');
  if(!track||!dots)return;
  const slides=Array.prototype.slice.call(track.children);
  if(!slides.length)return;
  const prev=document.querySelector('.steps-arw.prev');
  const next=document.querySelector('.steps-arw.next');
  const reduce=matchMedia('(prefers-reduced-motion: reduce)').matches;

  slides.forEach(function(_,i){
    const d=document.createElement('i');
    d.setAttribute('role','button');
    d.setAttribute('aria-label',(i+1)+'枚目を見る');
    d.addEventListener('click',function(){go(i);});
    dots.appendChild(d);
  });
  const marks=Array.prototype.slice.call(dots.children);

  // 画面の中央にいちばん近いカードを「いま見ているカード」とみなす
  function current(){
    const mid=track.scrollLeft+track.clientWidth/2;
    let best=0, bestDist=Infinity;
    slides.forEach(function(s,i){
      const d=Math.abs((s.offsetLeft+s.offsetWidth/2)-mid);
      if(d<bestDist){bestDist=d;best=i;}
    });
    return best;
  }
  function go(i){
    const s=slides[Math.max(0,Math.min(slides.length-1,i))];
    const left=s.offsetLeft-(track.clientWidth-s.offsetWidth)/2;
    if(track.scrollTo) track.scrollTo({left:left,behavior:reduce?'auto':'smooth'});
    else track.scrollLeft=left;
  }
  function sync(){
    const i=current();
    marks.forEach(function(m,k){m.classList.toggle('on',k===i);});
    if(prev)prev.disabled=(i===0);
    if(next)next.disabled=(i===slides.length-1);
  }
  let waiting=false;
  track.addEventListener('scroll',function(){
    if(waiting)return;
    waiting=true;
    requestAnimationFrame(function(){waiting=false;sync();});
  },{passive:true});
  addEventListener('resize',sync,{passive:true});
  if(prev)prev.addEventListener('click',function(){go(current()-1);});
  if(next)next.addEventListener('click',function(){go(current()+1);});
  sync();
})();

/* ===== 悩みリストの出し分け（?utm_content= で先頭を差し替え） ===== */
(function(){
  const list=document.getElementById('worryList');
  if(!list)return;
  const featured=new URLSearchParams(location.search).get('utm_content');
  if(!featured)return;
  const target=list.querySelector('li[data-key="'+(window.CSS&&CSS.escape?CSS.escape(featured):featured)+'"]');
  if(!target)return;
  list.insertBefore(target,list.firstElementChild); // 先頭へ移動
  target.classList.add('featured');                 // 強調（CSS側でボーダー太く）
})();

/* ===== modals ===== */
(function(){
  /* 下から出るパネルの中身。
     増やすときは、ここに { キー:{k,t,html} } を足して、
     HTML側のボタンに data-modal="そのキー" を付けてください。 */
  const DATA={
    profile:{k:'プロフィール',t:'占い師が頼る、占い師。',html:`
      <p>有名占いサイトに専属占い師として所属したのは、<strong>今から13年前</strong>。</p>
      <p>霊感霊視をベースに、タロットやルーンストーン、数秘術も組み合わせて鑑定していくと、「彼が言ってたことをズバリ当てられた」「ここまで当たったのは初めて」という声が続出。気づけばデビュー数ヶ月で、<strong>指名が絶えない人気占い師</strong>に。</p>
      <p>評判はやがて同業の占い師の耳にも届き、「相談に乗ってほしい」と声がかかるように。そこから大手占いサイトにもスカウトされて、今も現役で鑑定を続けています。</p>
      <p>さらに活動の幅は占いスクールの講師にも広がり、占い師になりたい人へのセッション方法や能力開発プログラムが好評を得て、これまで<strong>700名以上</strong>を占い師としてデビューさせてきました。</p>
      <ul class="fact-list">
        <li><span>鑑定歴</span>13年以上（のべ20,000人以上をサポート）</li>
        <li><span>得意分野</span>復縁・片想い・複雑愛／ビジネス・人間関係</li>
        <li><span>使用占術</span>霊感霊視／タロット／ルーンストーン／数秘術</li>
        <li><span>占いサイトのプロデュース</span>累計5サイト</li>
        <li><span>占い師の育成</span>700名以上をデビューさせた実績（セッション方法・能力開発プログラム指導）</li>
      </ul>
      <p>「鑑定する人」「育てる人」「サイトを作る人」。この3つを全部やってきたからこそ、あなたの気持ちも、<strong>悩みの奥にあるもの</strong>も、深いところまで見えます。</p>
      <p>実は占い業界ではちょっとした有名人。だけどその“表の顔”はここではナイショにして、一人の占い師としてこっそり向き合ってます。</p>`}
  };
  const modal=document.getElementById('modal');
  if(!modal)return;
  const mk=document.getElementById('mk'),mt=document.getElementById('mt'),mb=document.getElementById('mb');
  document.querySelectorAll('[data-modal]').forEach(b=>b.addEventListener('click',()=>{
    const d=DATA[b.dataset.modal];if(!d)return;
    mk.textContent=d.k;mt.textContent=d.t;mb.innerHTML=d.html;
    modal.classList.add('open');document.body.style.overflow='hidden';
  }));
  modal.querySelectorAll('[data-close]').forEach(el=>el.addEventListener('click',()=>{
    modal.classList.remove('open');document.body.style.overflow='';
  }));
})();

/* ===== background video: autoplay 保険 ===== */
(function(){
  const vids=document.querySelectorAll('.cospa-stage video');
  if(!vids.length)return;
  const tryPlay=()=>{vids.forEach(v=>{v.muted=true;v.playsInline=true;const p=v.play();if(p)p.catch(()=>{});});};
  tryPlay();
  const once=()=>{tryPlay();document.removeEventListener('touchend',once);document.removeEventListener('click',once);};
  document.addEventListener('touchend',once,{passive:true});
  document.addEventListener('click',once);
})();
