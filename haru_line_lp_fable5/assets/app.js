/* =========================================================
   BAKU LINE LP — interactions
   ========================================================= */

/* ===== site menu ===== */
(function(){
  var btn=document.getElementById('menuToggle');
  var menu=document.getElementById('siteMenu');
  if(!btn||!menu)return;
  function setMenu(open){
    btn.setAttribute('aria-expanded',open?'true':'false');
    btn.setAttribute('aria-label',open?'メニューを閉じる':'メニューを開く');
    menu.setAttribute('aria-hidden',open?'false':'true');
    menu.classList.toggle('open',open);
    document.body.classList.toggle('menu-open',open);
  }
  btn.addEventListener('click',function(){setMenu(btn.getAttribute('aria-expanded')!=='true');});
  menu.querySelectorAll('a').forEach(function(a){a.addEventListener('click',function(){setMenu(false);});});
})();

/* =========================================================
   WATER SURFACE — cinematic moonlit ripple
   - height-field wave sim
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
  let mcx,mcy;               // moon centre in sim coords
  let scaleBase;             // current downscale factor (raised if a device is slow)

  const DAMP    = 0.977;     // long-lived, calm ripples
  const REFRACT = 0.95;      // light-bending strength (bilinear → can push higher)
  const SPEC    = 7.5;       // moon-facing glint
  const FOAM    = 0.22;      // white sparkle on wave crests
  const CHROMA  = 1.6;       // prismatic edge dispersion

  function buildBG(){
    const off = document.createElement('canvas'); off.width=cols; off.height=rows;
    const o = off.getContext('2d');
    const g=o.createLinearGradient(0,0,0,rows);
    g.addColorStop(0,'#0d323d'); g.addColorStop(.30,'#0a2029'); g.addColorStop(.62,'#08141b'); g.addColorStop(1,'#04080c');
    o.fillStyle=g; o.fillRect(0,0,cols,rows);
    // starfield (upper sky) — refracted by ripples for a living reflection
    const stars=Math.round((cols*rows)/900);
    for(let i=0;i<stars;i++){
      const sxp=Math.random()*cols, syp=Math.random()*rows*0.5;
      const a=0.25+Math.random()*0.6, rad=Math.random()<0.14?1.4:0.8;
      const sg=o.createRadialGradient(sxp,syp,0,sxp,syp,rad*2.2);
      sg.addColorStop(0,'rgba(226,240,242,'+a+')'); sg.addColorStop(1,'rgba(226,240,242,0)');
      o.fillStyle=sg; o.fillRect(sxp-3,syp-3,6,6);
    }
    // moon halo + core
    mcx=cols*.5; mcy=rows*.13; const mr=Math.min(cols,rows)*.62;
    let mg=o.createRadialGradient(mcx,mcy,0,mcx,mcy,mr);
    mg.addColorStop(0,'rgba(214,236,238,.52)'); mg.addColorStop(.26,'rgba(159,184,189,.18)'); mg.addColorStop(1,'rgba(159,184,189,0)');
    o.fillStyle=mg; o.fillRect(0,0,cols,rows);
    let md=o.createRadialGradient(mcx,mcy,0,mcx,mcy,mr*.12);
    md.addColorStop(0,'rgba(255,255,255,.92)'); md.addColorStop(1,'rgba(255,255,255,0)');
    o.fillStyle=md; o.fillRect(0,0,cols,rows);
    bgData = o.getImageData(0,0,cols,rows).data;

    // moonlight reflection column (separable, cheap) — the shimmering "path"
    glare=new Float32Array(cols*rows);
    const wx=cols*0.11, upFall=rows*0.05, dnFall=rows*0.62, AMP=36;
    const gcol=new Float32Array(cols), grow=new Float32Array(rows);
    for(let x=0;x<cols;x++){ const dx=(x-mcx)/wx; gcol[x]=Math.exp(-dx*dx); }
    for(let y=0;y<rows;y++){ const dy=y-mcy; grow[y]=dy<0?Math.exp(-Math.pow(dy/upFall,2)):Math.exp(-Math.pow(dy/dnFall,2)); }
    for(let y=0;y<rows;y++){ const gr=grow[y]*AMP; for(let x=0;x<cols;x++){ glare[y*cols+x]=gcol[x]*gr; } }
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
  function drop(px,py,power,rad){
    const x=Math.floor(px/W*cols), y=Math.floor(py/H*rows), r=rad||3;
    for(let j=-r;j<=r;j++)for(let i=-r;i<=r;i++){
      const xx=x+i,yy=y+j; if(xx<1||yy<1||xx>=cols-1||yy>=rows-1)continue;
      const d=Math.hypot(i,j); if(d<=r) prev[yy*cols+xx]+=power*(1-d/(r+1));
    }
  }
  function step(){
    const c=cols;
    for(let y=1;y<rows-1;y++){ let idx=y*c+1;
      for(let x=1;x<c-1;x++,idx++){
        cur[idx]=((prev[idx-1]+prev[idx+1]+prev[idx-c]+prev[idx+c])*.5 - cur[idx])*DAMP;
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
        // ---- lighting ----
        const lvx=mcx-x, lvy=mcy-y, inv=1/Math.sqrt(lvx*lvx+lvy*lvy+1);
        const ndl=(gx*lvx+gy*lvy)*inv;               // slope facing the moon
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
    // glowing tap rings
    if(rings.length){
      ctx.globalCompositeOperation='lighter';
      for(let i=rings.length-1;i>=0;i--){
        const rg=rings[i], age=now-rg.t; if(age>1000){rings.splice(i,1);continue;}
        const k=age/1000, rad=8+k*Math.min(W,H)*0.28, a=(1-k)*0.5;
        ctx.strokeStyle='rgba(214,236,238,'+a+')'; ctx.lineWidth=2*(1-k)+0.4;
        ctx.beginPath(); ctx.arc(rg.x,rg.y,rad,0,6.283); ctx.stroke();
      }
      ctx.globalCompositeOperation='source-over';
    }
    if(reduce) return;
    // drifting luminous motes
    ctx.globalCompositeOperation='lighter';
    for(const m of motes){
      m.y+=m.vy; m.x+=Math.sin(now*0.0006*m.sway+m.ph)*0.35;
      if(m.y>H+16){ Object.assign(m,newMote(true)); continue; }
      if(now>m.next){ drop(m.x,m.y,16,2); m.next=now+2200+Math.random()*3200; } // touch the water
      const a=m.base*(0.55+0.45*Math.sin(now*0.001*m.tw+m.ph));
      const g=ctx.createRadialGradient(m.x,m.y,0,m.x,m.y,m.rad);
      g.addColorStop(0,'rgba(233,224,190,'+a+')');
      g.addColorStop(.45,'rgba(176,205,208,'+(a*0.4)+')');
      g.addColorStop(1,'rgba(176,205,208,0)');
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
        if(star.y>0 && star.y<H){ drop(star.x,star.y,120,3); plip(.5); } // splash
        star=null;
      }
    }
    ctx.globalCompositeOperation='source-over';
  }

  /* ===== main loop with light perf auto-tune ===== */
  let lastAuto=0, fpsT=0, fpsN=0, tuned=false;
  function loop(ts){
    step(); render();
    try{ drawOverlay(ts); }catch(err){ /* particles must never halt the water */ }
    if(!reduce && ts-lastAuto>7000){
      lastAuto=ts+Math.random()*4000;
      drop(W*(.1+Math.random()*.8),H*(.12+Math.random()*.72),44);
    }
    // one-time downscale if the device can't keep up
    if(!tuned){
      fpsT+=1; if(fpsN===0)fpsN=ts;
      if(fpsT===90){ const avg=(ts-fpsN)/90; if(avg>26 && scaleBase<6){ scaleBase++; resize(); } tuned=true; }
    }
    requestAnimationFrame(loop);
  }

  function pointer(e){
    if(e.target&&(e.target.closest('#snd')||e.target.closest('.modal-card')||e.target.closest('a')||e.target.closest('button')))return;
    const t=e.touches?e.touches[0]:e;
    drop(t.clientX,t.clientY,reduce?140:300);
    if(!reduce) rings.push({x:t.clientX,y:t.clientY,t:performance.now()});
    plip(reduce?.45:.9);
  }

  addEventListener('resize',resize,{passive:true});
  addEventListener('pointerdown',pointer,{passive:true});
  resize();
  initMotes();                 // W/H are ready only after the first resize()
  setTimeout(function(){drop(W*.5,H*.42,reduce?110:230);},700);
  requestAnimationFrame(loop);
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
    offer:'無料で電話鑑定を予約する',
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
  const DATA={
    profile:{k:'Profile',t:'占い師が頼る、占い師。',html:`
      <p>有名占いサイトの<strong>専属占い師</strong>として活躍。口コミで評判が広がり、やがて<strong>同業の占い師からも相談が集まる</strong>存在に。現在は6つの占いサイトの運営・監修も手がけています。</p>
      <p>相談実績は<strong>15,000人以上</strong>、育成した占い師は<strong>700名以上</strong>。恋する女性の本音を読み解いてきた、場数が違います。</p>
      <div class="big">「当てる」その先まで、導く。</div>
      <p>彼の本音、今の状況、これからの流れ。そして<strong>あなたが次にどう動けばいいか</strong>まで、電話ではっきりお伝えします。</p>`}
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
