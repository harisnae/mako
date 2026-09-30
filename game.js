'use strict';
/* ============================================================================
   APEX — an endless shark hunt  (game.js — the BEHAVIOUR layer)
   ----------------------------------------------------------------------------
   Everything the game DOES lives in this file. No imports, no build step:
   it is a plain script loaded at the end of <body> in index.html, so every
   DOM element it queries already exists, and all styling comes from
   style.css.

   ARCHITECTURE (top to bottom):
     helpers    -> tiny math / DOM utilities used everywhere
     canvas     -> the drawing surface + resize handling
     dom refs   -> cached references to HUD / overlay elements
     state      -> tuning constants (CFG), global state (S), entity pools
     audio      -> sound effects synthesized with WebAudio (no files to host)
     ui helpers -> overlay show/hide, score display, mute toggle
     game flow  -> resetRun / startGame / gameOver / pause
     input      -> ONE press() entry point, routed by the current state
     spawning   -> fish schools + hazard patterns (mines / fields / jellyfish)
     actions    -> thrust, eat, die — the events that change state
     updates    -> per-frame simulation: shark physics, world, collisions
     drawing    -> every visual, painted onto the canvas in layers
     main loop  -> requestAnimationFrame driver with delta-time + slow-mo
     init       -> one-time setup, then start the loop

   STATE MACHINE:  'menu' -> 'playing' -> 'dying' -> 'over'   (+ 'paused')
   ============================================================================ */

/* ================= helpers ================= */
// Shorthand for querySelector — every HUD/overlay element is grabbed
// through this once at startup, never re-queried per frame.
const $=s=>document.querySelector(s);
// Two pi — a full circle in radians; used for oscillations and full arcs.
const TAU=Math.PI*2;
// Constrain v into the [a,b] range — physics limits, spawn bands, alpha fades.
const clamp=(v,a,b)=>v<a?a:v>b?b:v;
// Linear interpolation from a toward b by t (0..1) — easing, colour fades,
// difficulty ramps.
const lerp=(a,b,t)=>a+(b-a)*t;
// Random float in [a,b).
const rand=(a,b)=>a+Math.random()*(b-a);
// Interpolate two [r,g,b] colour arrays into an 'rgb(r,g,b)' string.
// This is what fades the entire palette darker as the score climbs
// (driven by S.depthT) — the game's "descending into the midnight zone".
const lerpC=(a,b,t)=>'rgb('+Math.round(lerp(a[0],b[0],t))+','+Math.round(lerp(a[1],b[1],t))+','+Math.round(lerp(a[2],b[2],t))+')';
// Deterministic pseudo-random from an integer seed: same seed, same value
// (0..1). Used for kelp placement so strands stay anchored to the world as
// it scrolls instead of flickering to new random spots every frame.
function hash(n){const x=Math.sin(n*127.1)*43758.5453;return x-Math.floor(x);}

/* ================= canvas ================= */
// The game surface from index.html and its 2D drawing context.
const canvas=$('#sea'), ctx=canvas.getContext('2d');
// W/H = viewport size in CSS pixels. vign = cached vignette gradient —
// it is expensive to build, so it is only recreated on resize, not per frame.
let W=0,H=0,vign=null;
// Match the canvas pixel buffer to the window, scaled by devicePixelRatio
// (capped at 2) so rendering stays sharp on retina screens without paying
// full fill-rate. ctx.setTransform makes ALL game math use CSS pixels.
// vign=null forces the cached vignette to be rebuilt for the new size.
function resize(){
  const dpr=Math.min(2,window.devicePixelRatio||1);
  W=window.innerWidth; H=window.innerHeight;
  canvas.width=W*dpr; canvas.height=H*dpr;
  canvas.style.width=W+'px'; canvas.style.height=H+'px';
  ctx.setTransform(dpr,0,0,dpr,0,0);
  vign=null;
}
// Re-run the setup whenever the browser window changes size.
window.addEventListener('resize',resize);

/* ================= dom refs ================= */
// Every DOM element the game touches, queried once. Ids match index.html:
// score/depth = HUD readouts; menu/over/paused = the three overlays;
// cause/finalScore/overBest/newBest/menuBest = text slots filled by JS;
// icoOn/icoOff = the two speaker icons swapped by the mute toggle.
const scoreEl=$('#score'), depthEl=$('#depth'),
      menuEl=$('#menu'), overEl=$('#over'), pausedEl=$('#paused'),
      causeEl=$('#cause'), finalScoreEl=$('#finalScore'),
      overBestEl=$('#overBest'), newBestEl=$('#newBest'), menuBestEl=$('#menuBest'),
      icoOn=$('#icoOn'), icoOff=$('#icoOff');

/* ================= state ================= */
// Central tuning knobs — change these to re-balance the whole game:
//   gravity   : downward pull (px/s^2). The shark ALWAYS sinks by default.
//   drag      : water resistance; bleeds off vertical speed each frame
//               (this is what makes the kick feel floaty rather than snappy)
//   impulse   : vertical velocity SET on every click/tap (negative = upward)
//   baseSpeed : world scroll speed (px/s) at 0 fish; grows with the score
const CFG={gravity:800,drag:1.8,impulse:-400,baseSpeed:230};
// Global game state:
//   state        : state machine — 'menu'|'playing'|'dying'|'over'|'paused'
//   t            : total elapsed time; drives every animation in the game
//   worldX       : total distance scrolled (anchors sand/kelp/dunes to world)
//   runDist      : distance THIS run (drives the depth meter readout)
//   speed        : current scroll speed (+10 px/s per fish, capped +330)
//   score        : fish eaten this run
//   best         : all-time record, persisted in localStorage ('apex.best')
//   depthT       : 0..1 darkness factor — full abyss at 25 fish
//   timescale    : 1 = normal; eased to 0.12 on death for slow motion
//   shake        : screen-shake amplitude in px (set on death, decays)
//   deathTimer   : seconds since death (runs slow-mo, then shows game over)
//   cause        : death cause string shown on the game-over screen
//   newBest      : true if this run beat the stored record
//   overLockUntil: timestamp before which restart input is ignored
//   muted        : sound preference, persisted in localStorage ('apex.muted')
const S={
  state:'menu', t:0, worldX:0, runDist:0,
  speed:CFG.baseSpeed, score:0,
  best:+(localStorage.getItem('apex.best')||0),
  depthT:0, timescale:1, shake:0,
  deathTimer:0, cause:'', newBest:false, overLockUntil:0,
  muted:localStorage.getItem('apex.muted')==='1'
};
// The player. x is fixed in screen space; y is fully simulated.
//   vy        : vertical velocity (px/s)
//   pitch     : nose-up/down tilt in radians (eased toward vy)
//   rot       : full-body rotation used ONLY for the belly-up death tumble
//   mouth     : 0..1 current jaw openness (eased toward mouthT)
//   mouthT    : target openness — 1 when a fish is close ahead (anticipation)
//   bite      : 1 right after eating, then decays; forces a bite animation
//   tail      : phase of the tail-wag oscillation (speed scales with swimming)
//   tailBoost : temporary tail-speed burst right after a thrust kick
const shark={x:0,y:0,vy:0,pitch:0,rot:0,mouth:0,mouthT:0,bite:0,tail:0,tailBoost:0};
// Entity pools. fish/hazards are live gameplay objects; parts are particles
// (bubbles, bits, blood, glow motes); pops are floating "+1" score texts.
const fish=[], hazards=[], parts=[], pops=[];
// Distance (in scrolled pixels) until the next spawn pattern fires.
// lastDepth caches the depth meter text so the DOM is only written when
// the rounded value actually changes.
let nextSpawn=520, lastDepth=-1;
// Ambient background layers: marine-snow flakes (appear when deep) and
// distant fish silhouettes. Both wrap around the screen edges forever.
const snow=[], silh=[];

// Height of the sand floor at screen x. Shared by PHYSICS (the shark's
// lower bound) and DRAWING (the sand silhouette + kelp roots), so what you
// see and what you collide with can never disagree. Two out-of-phase sine
// waves = gently rolling dunes.
function floorTop(sx){
  const wx=sx+S.worldX;
  return H-64+Math.sin(wx*0.008)*9+Math.sin(wx*0.021+2)*5;
}

/* ================= audio (synthesized, no files) ================= */
// Every sound effect is generated at runtime with the WebAudio API —
// nothing to host, nothing to download. AC = AudioContext, master = a
// single gain node all sounds route through (muting = one gain change),
// noiseBuf = 1 second of white noise reused by every noise-based effect.
let AC=null, master=null, noiseBuf=null;
// Lazily build the audio system on the first user gesture (browsers block
// audio until the page has been interacted with) and resume it if the
// browser had suspended the context. Safe to call as often as needed.
function ensureAudio(){
  if(!AC){
    const Ctor=window.AudioContext||window.webkitAudioContext;
    if(!Ctor) return;                      // very old browser: stay silent
    AC=new Ctor();
    master=AC.createGain();
    master.gain.value=S.muted?0:0.5;       // respect the stored mute choice
    master.connect(AC.destination);
    noiseBuf=AC.createBuffer(1,AC.sampleRate,AC.sampleRate);
    const d=noiseBuf.getChannelData(0);
    for(let i=0;i<d.length;i++) d[i]=Math.random()*2-1;   // fill with noise
  }
  if(AC.state==='suspended') AC.resume();
}
// Shared gain envelope: near-instant attack up to 'peak', then exponential
// decay over 'dur' seconds. Gives every effect a percussive shape.
function env(g,t,peak,dur){
  g.gain.setValueAtTime(0.0001,t);
  g.gain.exponentialRampToValueAtTime(peak,t+0.012);
  g.gain.exponentialRampToValueAtTime(0.0001,t+dur);
}
// Thrust kick: a short band-passed slice of white noise — a watery "swish".
// Chain: noise source -> bandpass filter (700 Hz) -> gain envelope -> master.
function playThrust(){
  if(!AC||S.muted) return;
  const t=AC.currentTime;
  const src=AC.createBufferSource(); src.buffer=noiseBuf;
  const f=AC.createBiquadFilter(); f.type='bandpass'; f.frequency.value=700; f.Q.value=0.8;
  const g=AC.createGain(); env(g,t,0.10,0.16);
  src.connect(f); f.connect(g); g.connect(master);
  src.start(t); src.stop(t+0.2);
}
// Eating a fish: two layers — a low-passed noise burst (the bite) plus a
// square wave pitching down 240->70 Hz (the "gulp"). 3D-chomp in 0.12 s.
function playChomp(){
  if(!AC||S.muted) return;
  const t=AC.currentTime;
  const src=AC.createBufferSource(); src.buffer=noiseBuf;
  const f=AC.createBiquadFilter(); f.type='lowpass'; f.frequency.value=900;
  const g=AC.createGain(); env(g,t,0.30,0.10);
  src.connect(f); f.connect(g); g.connect(master);
  src.start(t); src.stop(t+0.12);
  const o=AC.createOscillator(); o.type='square';
  o.frequency.setValueAtTime(240,t);
  o.frequency.exponentialRampToValueAtTime(70,t+0.11);
  const g2=AC.createGain(); env(g2,t,0.16,0.12);
  o.connect(g2); g2.connect(master);
  o.start(t); o.stop(t+0.14);
}
// Death: a sine wave sliding 150->36 Hz (a deep, physical boom) plus a
// muffled low-passed noise wash for the impact.
function playDeath(){
  if(!AC||S.muted) return;
  const t=AC.currentTime;
  const o=AC.createOscillator(); o.type='sine';
  o.frequency.setValueAtTime(150,t);
  o.frequency.exponentialRampToValueAtTime(36,t+0.55);
  const g=AC.createGain(); env(g,t,0.5,0.65);
  o.connect(g); g.connect(master);
  o.start(t); o.stop(t+0.7);
  const src=AC.createBufferSource(); src.buffer=noiseBuf;
  const f=AC.createBiquadFilter(); f.type='lowpass'; f.frequency.value=420;
  const g2=AC.createGain(); env(g2,t,0.35,0.5);
  src.connect(f); f.connect(g2); g2.connect(master);
  src.start(t); src.stop(t+0.55);
}
// New record: a small rising 3-note arpeggio (C5, E5, G5) on triangle
// waves, staggered 100 ms apart.
function playBest(){
  if(!AC||S.muted) return;
  const t=AC.currentTime;
  [523.25,659.25,783.99].forEach((fq,i)=>{
    const o=AC.createOscillator(); o.type='triangle'; o.frequency.value=fq;
    const g=AC.createGain(); const st=t+i*0.1;
    g.gain.setValueAtTime(0.0001,st);
    g.gain.exponentialRampToValueAtTime(0.14,st+0.02);
    g.gain.exponentialRampToValueAtTime(0.0001,st+0.22);
    o.connect(g); g.connect(master);
    o.start(st); o.stop(st+0.25);
  });
}

/* ================= ui helpers ================= */
// Overlay visibility is entirely CSS-driven: the .show class controls
// opacity + pointer-events. These two functions are the only switch.
function show(el){el.classList.add('show');}
function hide(el){el.classList.remove('show');}
// Mirror the score into the big HUD number.
function updateScoreUI(){scoreEl.textContent=S.score;}
// Quick scale "pop" on the score number, via the Web Animations API
// (no CSS keyframes needed; runs on the compositor).
function popScore(){
  scoreEl.animate(
    [{transform:'scale(1)'},{transform:'scale(1.28)'},{transform:'scale(1)'}],
    {duration:240,easing:'ease-out'}
  );
}
// Flip the mute preference: persist it, apply it to the master gain node,
// and swap which speaker icon is visible in the HUD.
function toggleMute(){
  S.muted=!S.muted;
  localStorage.setItem('apex.muted',S.muted?'1':'0');
  if(master) master.gain.value=S.muted?0:0.5;
  icoOn.classList.toggle('hidden',S.muted);
  icoOff.classList.toggle('hidden',!S.muted);
}

/* ================= game flow ================= */
// Wipe everything back to a clean pre-run state: empty all four entity
// pools, reset speed/score/timers/atmosphere, and park the shark at its
// start position (24% across the screen, 45% down). Runs before every game.
function resetRun(){
  fish.length=0; hazards.length=0; parts.length=0; pops.length=0;
  S.speed=CFG.baseSpeed; S.score=0; S.depthT=0; S.timescale=1; S.shake=0;
  S.runDist=0; S.cause=''; S.newBest=false; nextSpawn=520;
  shark.x=Math.max(70,W*0.24); shark.y=H*0.45; shark.vy=0;
  shark.pitch=0; shark.rot=0; shark.mouth=0; shark.mouthT=0;
  shark.bite=0; shark.tail=0; shark.tailBoost=0;
  updateScoreUI(); lastDepth=-1;
}
// Begin a run: reset, enter 'playing', reveal the HUD (the body.playing
// class fades the HUD children in via CSS), hide every overlay, and fire
// one immediate thrust — so the input that started the game is ALSO the
// first kick, exactly like the Chrome dino's first jump.
function startGame(){
  resetRun();
  S.state='playing';
  document.body.classList.add('playing');
  hide(menuEl); hide(overEl); hide(pausedEl);
  thrust();
}
// End a run: enter 'over', start a 450 ms restart lockout (so the same
// key-mash that killed you can't instantly restart), check and save a new
// record (jingle if beaten), write the results into the overlay, fade the
// HUD out (body.playing removed), and reveal the game-over screen.
function gameOver(){
  S.state='over';
  S.overLockUntil=performance.now()+450;
  S.newBest=S.score>S.best;
  if(S.newBest){
    S.best=S.score;
    localStorage.setItem('apex.best',S.best);
    playBest();
  }
  causeEl.textContent=S.cause;
  finalScoreEl.textContent=S.score;
  overBestEl.textContent='BEST · '+S.best+' FISH';
  newBestEl.classList.toggle('hidden',!S.newBest);
  document.body.classList.remove('playing');
  show(overEl);
}
// Pausing only makes sense from 'playing'; resuming returns to it.
function togglePause(){
  if(S.state==='playing'){ S.state='paused'; show(pausedEl); }
  else if(S.state==='paused'){ resumeGame(); }
}
function resumeGame(){ S.state='playing'; hide(pausedEl); }

/* ================= input ================= */
// THE single input entry point. Every click, tap and key press funnels
// through here and is routed by the current state:
//   menu    -> start the run (which also fires the first kick)
//   playing -> thrust upward
//   over    -> restart, but only once the 450 ms lockout has expired
//   paused  -> resume
//   dying   -> ignored — let the death animation play out untouched
function press(){
  ensureAudio();
  if(S.state==='menu'){ startGame(); return; }
  if(S.state==='playing'){ thrust(); return; }
  if(S.state==='over'){
    if(performance.now()>S.overLockUntil) startGame();
    return;
  }
  if(S.state==='paused'){ resumeGame(); return; }
}
// Any pointer press anywhere on the page = one game input. Presses that
// land on a <button> are skipped here (buttons have their own handlers
// below) so, e.g., the mute button doesn't ALSO fire a thrust.
// preventDefault kills text-selection / double-tap-zoom side effects.
window.addEventListener('pointerdown',e=>{
  if(e.target.closest('button')) return;
  e.preventDefault();
  press();
});
// Keyboard: Space / ArrowUp / W all map to the same single input;
// P toggles pause. e.repeat filters key auto-repeat (holding a key must
// not machine-gun thrusts). If a button currently has focus, skip — the
// browser's native Space-activates-button would double-fire the input.
window.addEventListener('keydown',e=>{
  if(e.repeat) return;
  if(e.target&&e.target.tagName==='BUTTON') return;
  if(e.code==='Space'||e.code==='ArrowUp'||e.code==='KeyW'){
    e.preventDefault(); press();
  }else if(e.code==='KeyP'){ togglePause(); }
});
// Suppress the long-press context menu on the canvas (mobile) — it would
// interrupt the tap rhythm.
window.addEventListener('contextmenu',e=>{ if(e.target===canvas) e.preventDefault(); });
// The three real buttons. blur() after click so a later Space press isn't
// swallowed by (or double-fired through) the still-focused button.
$('#startBtn').addEventListener('click',e=>{e.currentTarget.blur();press();});
$('#retryBtn').addEventListener('click',e=>{e.currentTarget.blur();press();});
$('#muteBtn').addEventListener('click',e=>{e.stopPropagation();ensureAudio();toggleMute();});
// Auto-pause when the tab is hidden (tab switch / minimise) so the player
// never returns to a dead shark they couldn't see coming.
document.addEventListener('visibilitychange',()=>{
  if(document.hidden&&S.state==='playing') togglePause();
});

/* ================= spawning ================= */
// Create a school of n fish strung out horizontally from (x,y). Each fish
// gets its own bob phase/amplitude (they ripple as a group) and a small
// leftward swim speed of its own, so schools drift independently of the
// water. baseY is the anchor the sine bob oscillates around.
function spawnSchool(x,y,n){
  for(let i=0;i<n;i++){
    fish.push({
      x:x+i*36,                                    // 36 px apart in a line
      baseY:clamp(y+Math.sin(i*1.7)*14,Math.min(120,H*0.15),H-Math.min(140,H*0.18)), // gentle arc + safety clamp
      y:y, ph:rand(0,TAU), amp:rand(5,11),         // bob phase + amplitude
      vx:rand(15,45), ph2:rand(0,TAU), panic:false // own speed + tail-flick phase
    });
  }
}
// The spawn director. Every time the spawn timer (nextSpawn, measured in
// SCROLLED PIXELS, so spacing scales automatically with speed) runs out,
// exactly ONE pattern is chosen by a weighted roll and pushed in from the
// right edge (x = W+80). Probability bands:
//   roll < 0.32         -> fish school        (32%)
//   roll < 0.70         -> single mine        (38%)
//   roll < 0.70+fieldP  -> seabed minefield   (12-25%, grows with score)
//   else                -> jellyfish          (whatever remains)
function spawnPattern(){
  const diff=clamp((S.speed-CFG.baseSpeed)/330,0,1); // difficulty 0..1
  const gapScale=lerp(1.3,0.75,diff);                // gaps shrink as it rises
  const topY=Math.min(130,H*0.16), botY=H-Math.min(154,H*0.18);
  const roll=Math.random();
  // minefields get more frequent as the score climbs (12% -> 25%)
  const fieldP=0.12+Math.min(0.13,S.score*0.004);

  // 1. Fish band — trim slightly to fund the extra mines
  if(roll<0.32){                     // was 0.40
  
    // fish schools drift in the upper 60% — food lives above the danger
    spawnSchool(W+60, rand(topY, topY+(botY-topY)*0.6), 2+((Math.random()*3)|0));
    nextSpawn=rand(300,460)*gapScale;

  // 2. Single-mine band — widen it (26% -> 38% of all spawns)
  }else if(roll<0.70){               // was 0.66

    // single mine — 2 out of 3 hug the seabed, the rest float mid-water
  // 3. THE key line — the seabed vs mid-water split.
  //    Lowering this threshold sends more mines down the mid-water path.
  const my=Math.random()<0.45      // was 0.66
    ? floorTop(W+80)-rand(36,95)   // seabed path
    : rand(topY+20,botY-20);       // <- mid-water random mines (the ones you want more of)
    hazards.push({kind:'mine',x:W+80,y:my,t:rand(0,9),ph:rand(0,TAU),par:1});
    // bait always floats ABOVE the mine now, never below it
    if(Math.random()<0.55)
      spawnSchool(W+150, clamp(my-rand(150,210), topY, botY), 3);
    nextSpawn=rand(380,560)*gapScale;

  // 4. Field band start follows the new edge
  }else if(roll<0.70+fieldP){        // was 0.66+fieldP
  
    // NEW: seabed minefield — a row of mines parked on the floor.
    // Sinking here is death, so the player must keep tapping to stay high.
    const count=2+((Math.random()*3)|0);          // 2–4 mines
    for(let i=0;i<count;i++){
      const mx=W+80+i*rand(70,110);
      hazards.push({
        kind:'mine',
        x:mx,
        y:floorTop(mx)-rand(36,62),               // sits just above the local sand line
        t:rand(0,9), ph:rand(0,TAU), par:1
      });
    }
    // reward for crossing at altitude: a school right above the field
    if(Math.random()<0.7)
      spawnSchool(W+180, rand(topY, topY+(botY-topY)*0.45), 3);
    nextSpawn=rand(440,620)*gapScale;

  }else{
    // jellyfish (unchanged)
    const jy=rand(topY+40,botY);
    hazards.push({kind:'jelly',x:W+80,y:jy,vy:rand(14,34),t:rand(0,9),ph:rand(0,TAU),par:0.88});
    if(Math.random()<0.5)
      spawnSchool(W+150, clamp(jy+(Math.random()<0.5?-1:1)*rand(150,210),topY,botY),3);
    nextSpawn=rand(380,560)*gapScale;
  }
  // Floor on the gap: two patterns can never arrive closer than 260 px of
  // scroll — the player is always guaranteed some reaction time.
  nextSpawn=Math.max(nextSpawn,260);
}

/* ================= actions ================= */
// The core move. SETS vertical velocity to the upward impulse (Flappy-style:
// predictable regardless of current speed), flicks the tail faster, plays
// the swish, and exhales bubbles from the tail. Deep in the abyss
// (depthT > 0.35) the kick also stirs up glowing bioluminescent motes —
// a reward for having descended that far.
function thrust(){
  shark.vy=CFG.impulse;
  shark.tailBoost=1;
  playThrust();
  for(let k=0;k<3;k++)
    parts.push({type:'bubble',x:shark.x-38+rand(-6,6),y:shark.y+rand(-8,8),vx:0,vy:-rand(30,90),size:rand(1.2,2.6),life:rand(0.4,0.9),max:0.9});
  if(S.depthT>0.35)
    for(let k=0;k<3;k++)
      parts.push({type:'glow',x:shark.x-30+rand(-12,12),y:shark.y+rand(-12,12),vx:-rand(10,50),vy:rand(-18,18),size:rand(1.8,3.6),life:rand(0.5,1.1),max:1.1});
}
// A hard landing on the seabed throws up a small sand cloud.
function sandPuff(){
  for(let k=0;k<6;k++)
    parts.push({type:'bit',col:[206,176,128],x:shark.x+rand(-24,24),y:floorTop(shark.x)-4,vx:rand(-60,60),vy:rand(-90,-20),size:rand(1.5,3),life:rand(0.3,0.6),max:0.6});
}
// Swallow fish[i]: remove it, +1 score (HUD update + pop animation), spawn
// a floating "+1", spray fish-bit particles and bubbles, snap the jaw into
// its bite animation (shark.bite), and play the chomp.
function eatFish(i){
  const f=fish[i]; fish.splice(i,1);
  S.score++; updateScoreUI(); popScore();
  pops.push({x:f.x,y:f.y-16,txt:'+1',life:0.8,max:0.8});
  for(let k=0;k<7;k++)
    parts.push({type:'bit',col:[255,196,107],x:f.x,y:f.y,vx:rand(-130,130),vy:rand(-170,30),size:rand(1.6,3.4),life:rand(0.35,0.75),max:0.75});
  for(let k=0;k<3;k++)
    parts.push({type:'bubble',x:f.x+rand(-6,6),y:f.y,vx:0,vy:-rand(30,70),size:rand(1.5,3),life:rand(0.5,1.1),max:1.1});
  shark.bite=1;
  playChomp();
}
// Death. Switches to 'dying' (the main loop runs slow motion from here),
// records the cause text for the game-over screen, kicks off screen shake,
// starts the belly-up tumble (rot eases toward PI), bursts a blood cloud +
// bubble spray, and plays the boom. Note: the seabed is NOT lethal — only
// hazards call this.
function die(kind){
  S.state='dying'; S.deathTimer=0; S.timescale=1;
  S.cause=kind==='mine'?'YOU SWAM INTO A NAVAL MINE':'STUNG BY A BOX JELLYFISH';
  S.shake=16;
  shark.rot=shark.pitch; shark.vy=-30; shark.mouthT=1;
  for(let k=0;k<14;k++)
    parts.push({type:'blood',x:shark.x+rand(-14,14),y:shark.y+rand(-10,10),vx:rand(-50,50),vy:rand(-50,50),size:rand(3,7),life:rand(0.9,1.6),max:1.6});
  for(let k=0;k<14;k++)
    parts.push({type:'bubble',x:shark.x+rand(-20,20),y:shark.y+rand(-12,12),vx:0,vy:-rand(40,110),size:rand(1.5,4),life:rand(0.6,1.4),max:1.4});
  playDeath();
}

/* ================= updates ================= */
// Per-frame shark simulation, branched by state:
//   menu         -> idle cruise on a sine wave (a living title screen)
//   dying / over -> buoyant corpse: floats up slowly, drifts backward,
//                   rotates toward PI (belly-up), jaw relaxes open, and
//                   while still 'dying' bubbles leak from the mouth
//   playing      -> the real physics, below
function updateShark(dt){
  // MENU: not player-controlled — a gentle sine cruise with the pitch
  // following the wave's slope, so the splash screen feels alive.
  if(S.state==='menu'){
    shark.y=H*0.46+Math.sin(S.t*0.9)*26;
    shark.pitch=Math.cos(S.t*0.9)*0.09;
    shark.tail+=dt*3.2;
    return;
  }
  // DYING / OVER: the timescale from the main loop makes all of this play
  // in dramatic slow motion. y is floored at 112 so the corpse never
  // sinks out of view behind the overlay.
  if(S.state==='dying'||S.state==='over'){
    shark.vy-=46*dt; shark.vy=clamp(shark.vy,-55,60);
    shark.y+=shark.vy*dt; shark.y=Math.max(shark.y,112);
    shark.x-=10*dt;
    shark.rot+=(Math.PI-shark.rot)*Math.min(1,dt*1.5);
    shark.mouth+=(1-shark.mouth)*Math.min(1,dt*3);
    shark.tail+=dt*1.2;
    if(S.state==='dying'&&Math.random()<dt*10)
      parts.push({type:'bubble',x:shark.x+38,y:shark.y+rand(-4,8),vx:0,vy:-rand(30,80),size:rand(1.5,3),life:rand(0.5,1.2),max:1.2});
    return;
  }
  // playing: buoyancy physics
  // 1) gravity accelerates downward; water drag bleeds a proportional
  //    fraction of vy every frame; vy is clamped so no frame can fling
  //    the shark absurdly far.
  shark.vy+=CFG.gravity*dt;
  shark.vy-=shark.vy*CFG.drag*dt;
  shark.vy=clamp(shark.vy,-540,640);
  shark.y+=shark.vy*dt;
  // 2) soft bounds — the surface and seabed are SAFE (only hazards kill).
  //    Hitting one reverses a fraction of vy: a damped bounce, not a stop.
  const top=Math.min(100,H*0.12), bot=floorTop(shark.x)-26;
  if(shark.y<top){ shark.y=top; shark.vy*=-0.3; }
  if(shark.y>bot){
    shark.y=bot;
    if(shark.vy>180) sandPuff();
    shark.vy*=-0.28;
  }
  // 3) visual pitch: tilt the nose toward the direction of travel, eased
  //    so it lags the velocity slightly (feels like momentum in water).
  shark.pitch+=(clamp(shark.vy*0.0011,-0.42,0.5)-shark.pitch)*Math.min(1,dt*9);
  // 4) tail wag: base speed + faster with world speed + a kick burst.
  shark.tail+=dt*(5+S.speed*0.012+shark.tailBoost*12);
  shark.tailBoost=Math.max(0,shark.tailBoost-dt*3);
  shark.bite=Math.max(0,shark.bite-dt*4);
  // mouth opens when food is close ahead
  // Anticipation: if any fish sits in a cone ahead of the mouth (within
  // 150 px forward, 70 px vertical), target the jaw wide open — the shark
  // visibly "locks on" before the catch lands.
  let open=0;
  for(const f of fish){
    const dx=f.x-(shark.x+48), dy=f.y-shark.y;
    if(dx>-30&&dx<150&&Math.abs(dy)<70){ open=1; break; }
  }
  shark.mouthT=open;
  shark.mouth+=(shark.mouthT-shark.mouth)*Math.min(1,dt*10);
}

// Per-frame world simulation: scrolling, difficulty, every entity pool,
// ambient layers, particle physics and popups. dt arrives already scaled
// by the slow-mo timescale from the main loop.
function updateWorld(dt){
  const st=S.state;
  // Scroll speed by state: frozen on the game-over screen, 45% on the menu
  // (a calmer title screen), full speed while playing.
  const sp=(st==='over'?0:S.speed*(st==='menu'?0.45:1))*S.timescale;
  S.worldX+=sp*dt;
  if(st==='playing') S.runDist+=sp*dt;
  // Difficulty + atmosphere ramp, driven purely by the score:
  //   speed  -> +10 px/s per fish eaten (capped at +330)
  //   depthT -> full midnight-zone darkness at 25 fish
  if(st==='playing'){
    S.speed=CFG.baseSpeed+Math.min(330,S.score*10);
    S.depthT=Math.min(1,S.score/25);
  }
  // Fish: scroll left at world speed PLUS their own swim speed, bob on a
  // sine around their anchor, panic (faster tail flick) when the shark is
  // within 200 px, and despawn once fully past the left edge.
  for(let i=fish.length-1;i>=0;i--){
    const f=fish[i];
    f.x-=(sp+f.vx)*dt;
    f.y=f.baseY+Math.sin(S.t*2+f.ph)*f.amp;
    f.panic=(f.x-shark.x<200&&f.x-shark.x>-60);
    if(f.x<-80) fish.splice(i,1);
  }
  // Hazards: mines are fixed in the water (par=1); jellyfish drift at 88%
  // of world speed AND float slowly upward on their own. Despawn off-screen
  // or when a jellyfish reaches the surface.
  for(let i=hazards.length-1;i>=0;i--){
    const h=hazards[i];
    h.x-=sp*h.par*dt; h.t+=dt;
    if(h.kind==='jelly') h.y-=h.vy*dt;
    if(h.x<-80||h.y<70) hazards.splice(i,1);
  }
  // Spawn director: the countdown is in scrolled pixels, not seconds.
  if(st==='playing'){
    nextSpawn-=sp*dt;
    if(nextSpawn<=0) spawnPattern();
  }
  // Ambient bubbles: occasionally release one from below the bottom edge.
  if(Math.random()<dt*1.4){
    const l=rand(3,7);
    parts.push({type:'bubble',x:rand(0,W),y:H+8,vx:0,vy:-rand(16,40),size:rand(1.5,3.5),life:l,max:l});
  }
  // Background layers freeze along with the world on the game-over screen.
  const frozen=(st==='over')?0:1;
  // Distant silhouettes: slow parallax drift; respawn off the right edge.
  for(const s of silh){
    s.x-=(S.speed*0.22+s.v)*dt*frozen;
    if(s.x<-40){ s.x=W+rand(20,140); s.y=rand(70,Math.max(120,H-180)); }
  }
  // Marine snow: falls and drifts left, wrapping around all four edges so
  // the field never runs out.
  for(const p of snow){
    p.y+=p.v*dt; p.x-=S.speed*0.12*dt*frozen;
    if(p.y>H) p.y-=H;
    if(p.x<0) p.x+=W;
    if(p.x>W) p.x-=W;
  }
  // Particle physics — one behaviour per type:
  //   bit    -> fish chunks / sand: gravity + drag (arcs up, settles down)
  //   bubble -> rises with a sine wobble; dies at the surface line (y<36)
  //   glow   -> bioluminescent motes: simple drift; drawn additively
  //   blood  -> expands outward then slows (heavy drag); a soft red cloud
  for(let i=parts.length-1;i>=0;i--){
    const p=parts[i]; p.life-=dt;
    if(p.type==='bit'){
      p.vy+=420*dt; p.vx-=p.vx*2.5*dt;
      p.x+=p.vx*dt; p.y+=p.vy*dt;
    }else if(p.type==='bubble'){
      p.x+=(Math.sin(p.life*2.4+p.y*0.05)*14-16)*dt;
      p.y+=p.vy*dt;
      if(p.y<36) p.life=0;
    }else if(p.type==='glow'){
      p.x+=p.vx*dt; p.y+=p.vy*dt;
    }else if(p.type==='blood'){
      p.x+=p.vx*dt; p.y+=p.vy*dt;
      p.vx*=(1-1.5*dt); p.vy*=(1-1.5*dt);
    }
    if(p.life<=0) parts.splice(i,1);
  }
  // Score popups: float upward 46 px/s and fade over their lifetime.
  for(let i=pops.length-1;i>=0;i--){
    const p=pops[i];
    p.life-=dt; p.y-=46*dt;
    if(p.life<=0) pops.splice(i,1);
  }
}

// Collision detection — circle-based, run only while 'playing'.
// EATING: the shark's mouth is one circle at (x+48, y+pitch*46) with a
// generous radius of 34 so catches feel fair. Any fish whose centre falls
// inside is eaten. The loop runs BACKWARDS so splice() during iteration
// is safe.
// DYING: the shark is two circles (mouth + body). Each hazard is one:
//   mine  -> radius 24, INCLUDING its bob offset, so the hitbox matches
//            the drawn position exactly
//   jelly -> radius 20 at the bell (tentacles are forgivingly harmless)
// rr = sum of the two radii minus 4 px of forgiveness on every contact.
function collide(){
  const mx=shark.x+48, my=shark.y+shark.pitch*46;
  for(let i=fish.length-1;i>=0;i--){
    const f=fish[i], dx=f.x-mx, dy=f.y-my;
    if(dx*dx+dy*dy<34*34) eatFish(i);
  }
  const circles=[[mx,my,15],[shark.x-6,shark.y,20]];
  for(const h of hazards){
    let hx=h.x, hy=h.y, r=20;
    if(h.kind==='mine'){ hy=h.y+Math.sin(h.t*1.4+h.ph)*7; r=24; }
    else if(h.kind==='jelly'){ hy=h.y-6; r=20; }
    for(const c of circles){
      const dx=hx-c[0], dy=hy-c[1], rr=r+c[2]-4;
      if(dx*dx+dy*dy<rr*rr){ die(h.kind); return; }
    }
  }
}

/* ================= drawing ================= */
// The water palette as [r,g,b] stops: "*0" = shallow colours, "*1" = abyss
// colours. drawWater() lerps between the two sets by S.depthT, so the whole
// ocean visibly darkens from 0 to 25 fish — the game's signature escalation.
const WATER={
  top0:[40,134,138], mid0:[15,72,90], bot0:[6,33,45],
  top1:[9,46,62], mid1:[4,25,39], bot1:[1,8,14]
};
// Background: one vertical gradient covering the screen, its three stops
// interpolated between "shallow" and "abyss" by depthT.
function drawWater(){
  const d=S.depthT;
  const g=ctx.createLinearGradient(0,0,0,H);
  g.addColorStop(0,lerpC(WATER.top0,WATER.top1,d));
  g.addColorStop(0.55,lerpC(WATER.mid0,WATER.mid1,d));
  g.addColorStop(1,lerpC(WATER.bot0,WATER.bot1,d));
  ctx.fillStyle=g;
  ctx.fillRect(0,0,W,H);
}
// God rays: 5 slanted translucent light shafts from the surface, drawn with
// the 'lighter' composite mode (additive) so they BRIGHTEN the water. They
// sway slowly and fade out as depth increases — no sunlight in the midnight
// zone. Each ray is a gradient-filled, rotated, translated rectangle.
function drawRays(){
  if(S.depthT>0.96) return;
  const a=0.05*(1-S.depthT);
  ctx.save();
  ctx.globalCompositeOperation='lighter';
  for(let i=0;i<5;i++){
    const bx=W*(0.12+i*0.19)+Math.sin(S.t*0.13+i*1.7)*40;
    ctx.save();
    ctx.translate(bx,-60);
    ctx.rotate(0.30+Math.sin(S.t*0.09+i)*0.06);
    const g=ctx.createLinearGradient(0,0,0,H*0.85);
    g.addColorStop(0,'rgba(190,240,235,'+a+')');
    g.addColorStop(1,'rgba(190,240,235,0)');
    ctx.fillStyle=g;
    ctx.fillRect(-34-i*6,0,68+i*12,H*0.9);
    ctx.restore();
  }
  ctx.restore();
}
// Far parallax dunes: a second, more distant sand silhouette scrolling at
// HALF world speed behind everything — cheap depth cue.
function drawDunes(){
  ctx.fillStyle=lerpC([13,62,74],[3,20,30],S.depthT);
  ctx.beginPath();
  ctx.moveTo(0,H);
  for(let x=0;x<=W+40;x+=40){
    const wx=x+S.worldX*0.5;
    ctx.lineTo(x,H-120+Math.sin(wx*0.006)*22+Math.sin(wx*0.017)*9);
  }
  ctx.lineTo(W,H);
  ctx.closePath();
  ctx.fill();
}
// Distant fish silhouettes: tiny dark shapes drifting in the background,
// fading out as the water darkens (they would be invisible there anyway).
function drawSilhouettes(){
  const a=0.38*(1-S.depthT*0.8);
  if(a<=0.02) return;
  ctx.fillStyle='rgba(3,17,23,'+a+')';
  for(const s of silh){
    ctx.save();
    ctx.translate(s.x,s.y+Math.sin(S.t*0.8+s.ph)*9);
    ctx.scale(s.s,s.s);
    ctx.beginPath();
    ctx.ellipse(0,0,12,4.6,0,0,TAU);
    ctx.moveTo(-9,0); ctx.lineTo(-17,-5.5); ctx.lineTo(-17,5.5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
}
// Marine snow: faint falling motes that only appear once the water has
// darkened past depthT 0.22 — a classic deep-sea detail that sells the
// descent. Positions live in the `snow` array (updated in updateWorld).
function drawSnow(){
  if(S.depthT<0.22) return;
  ctx.fillStyle='rgba(220,240,240,'+(0.16*S.depthT)+')';
  for(const p of snow){
    ctx.beginPath();
    ctx.arc(p.x,p.y,p.r,0,TAU);
    ctx.fill();
  }
}
// The seabed: a sand silhouette traced from floorTop() — the SAME function
// the shark's physics collides with, so what you see is what you hit —
// plus a pale highlight along its top edge. Both darken toward blue-grey
// in the abyss.
function drawSand(){
  ctx.fillStyle=lerpC([201,169,122],[38,54,64],S.depthT*0.85);
  ctx.beginPath();
  ctx.moveTo(0,H);
  for(let x=0;x<=W+26;x+=26) ctx.lineTo(x,floorTop(x));
  ctx.lineTo(W,H);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle='rgba(255,240,210,'+(0.25*(1-S.depthT*0.6))+')';
  ctx.lineWidth=2;
  ctx.beginPath();
  for(let x=0;x<=W+26;x+=26){
    const y=floorTop(x);
    if(x===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
  }
  ctx.stroke();
}
// Kelp forest: strands are placed deterministically from hash(i) so they
// stay anchored to the WORLD as it scrolls (no flicker), sway on a slow
// sine, and darken with depth. Each clump is two bezier strokes — one
// thick, one thin — rooted just below the sand line.
function drawKelp(){
  const base=lerpC([18,70,62],[7,32,36],S.depthT);
  const chunk=170;
  const i0=Math.floor(S.worldX/chunk)-1;
  const n=Math.ceil(W/chunk)+3;
  ctx.lineCap='round';
  ctx.strokeStyle=base;
  for(let i=i0;i<i0+n;i++){
    const h1=hash(i);
    if(h1<0.4) continue;
    const bx=i*chunk-S.worldX+h1*110;
    const fy=floorTop(bx)+4;
    const hh=60+hash(i+13)*110;
    const sw=Math.sin(S.t*0.7+i*1.3)*0.35;
    ctx.lineWidth=5;
    ctx.beginPath();
    ctx.moveTo(bx,fy);
    ctx.bezierCurveTo(bx+sw*20,fy-hh*0.35,bx-sw*30,fy-hh*0.7,bx+sw*46,fy-hh);
    ctx.stroke();
    ctx.lineWidth=3;
    ctx.beginPath();
    ctx.moveTo(bx+4,fy);
    ctx.bezierCurveTo(bx+4-sw*16,fy-hh*0.3,bx+4+sw*24,fy-hh*0.55,bx+2-sw*30,fy-hh*0.75);
    ctx.stroke();
  }
}
// Hazards — one branch per kind.
// MINE: drawn at its bobbed centre (the SAME formula collide() uses, so
// the hitbox matches the picture exactly). Layers, back to front:
//   1. chain  -> zig-zag links dangling below the body
//   2. spikes -> 9 rounded prongs around the sphere
//   3. body   -> dark iron sphere with a faint rim highlight
//   4. light  -> blinking red LED + soft halo (brighter blink = fairer in
//                the dark abyss)
// JELLYFISH: a pulsing bell (squash-and-stretch on a sine), 5 swaying
// tentacles, and a translucent glow that INTENSIFIES with depth —
// bioluminescence keeps late-game jellies visible in the darkness.
function drawHazard(h){
  if(h.kind==='mine'){
    // bobbed centre — must match collide()'s hy calculation exactly
    const cy=h.y+Math.sin(h.t*1.4+h.ph)*7;
    ctx.save();
    ctx.translate(h.x,cy);
    ctx.strokeStyle='rgba(14,24,30,0.55)';
    ctx.lineWidth=2.5;
    ctx.beginPath();
    for(let k=0;k<4;k++){
      ctx.moveTo(0,16+k*8);
      ctx.lineTo(4,20+k*8);
      ctx.lineTo(0,24+k*8);
    }
    ctx.stroke();
    ctx.strokeStyle='#39434c';
    ctx.lineWidth=4.5;
    ctx.lineCap='round';
    ctx.beginPath();
    for(let k=0;k<9;k++){
      const a=k/9*TAU;
      ctx.moveTo(Math.cos(a)*15,Math.sin(a)*15);
      ctx.lineTo(Math.cos(a)*25,Math.sin(a)*25);
    }
    ctx.stroke();
    ctx.fillStyle='#242d35';
    ctx.beginPath(); ctx.arc(0,0,17,0,TAU); ctx.fill();
    ctx.strokeStyle='rgba(255,255,255,0.10)';
    ctx.lineWidth=2;
    ctx.beginPath(); ctx.arc(0,0,14,-2.4,-0.6); ctx.stroke();
    const blink=0.45+0.55*Math.abs(Math.sin(h.t*3.2+h.ph));
    ctx.fillStyle='rgba(255,72,72,'+(blink*0.18)+')';
    ctx.beginPath(); ctx.arc(0,0,10,0,TAU); ctx.fill();
    ctx.fillStyle='rgba(255,72,72,'+blink+')';
    ctx.beginPath(); ctx.arc(0,0,4,0,TAU); ctx.fill();
    ctx.restore();
  }else{
    ctx.save();
    ctx.translate(h.x,h.y);
    const p=(Math.sin(h.t*2.4+h.ph)+1)/2;
    const bw=20*(1+0.14*p), bh=16*(1-0.16*p);
    const glow=0.5+S.depthT*0.5;
    ctx.strokeStyle='rgba(255,150,180,'+(0.45*glow+0.15)+')';
    ctx.lineWidth=2;
    ctx.lineCap='round';
    for(let k=0;k<5;k++){
      const tx=-12+k*6;
      ctx.beginPath();
      ctx.moveTo(tx,6);
      ctx.quadraticCurveTo(tx+Math.sin(h.t*2+k)*5,20,tx+Math.sin(h.t*1.3+k*2)*8,34+(k%2)*4);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(-bw,4);
    ctx.quadraticCurveTo(-bw,-bh*1.4,0,-bh*1.4);
    ctx.quadraticCurveTo(bw,-bh*1.4,bw,4);
    ctx.quadraticCurveTo(bw*0.6,8,bw*0.33,4);
    ctx.quadraticCurveTo(0,8,-bw*0.33,4);
    ctx.quadraticCurveTo(-bw*0.6,8,-bw,4);
    ctx.closePath();
    ctx.fillStyle='rgba(255,140,170,'+(0.30*glow+0.12)+')';
    ctx.fill();
    ctx.strokeStyle='rgba(255,170,200,'+(0.75*glow)+')';
    ctx.lineWidth=2;
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(0,-bh*0.45,bw*0.5,bh*0.5,0,0,TAU);
    ctx.fillStyle='rgba(255,190,215,'+(0.25*glow)+')';
    ctx.fill();
    ctx.restore();
  }
}
// One fish: tail triangle (flicks faster when panicking near the shark),
// gold body, pale belly, dark eye with a white glint. Drawn facing left —
// the direction it travels.
function drawFish(f){
  ctx.save();
  ctx.translate(f.x,f.y);
  const flick=Math.sin(S.t*(f.panic?18:9)+f.ph2)*0.5;
  ctx.save();
  ctx.translate(8,0);
  ctx.rotate(flick*0.6);
  ctx.fillStyle='#e8a54b';
  ctx.beginPath();
  ctx.moveTo(0,0); ctx.lineTo(9,-6); ctx.lineTo(9,6);
  ctx.closePath(); ctx.fill();
  ctx.restore();
  ctx.fillStyle='#ffc46b';
  ctx.beginPath(); ctx.ellipse(0,0,10,6.5,0,0,TAU); ctx.fill();
  ctx.fillStyle='rgba(255,236,190,0.8)';
  ctx.beginPath(); ctx.ellipse(0,2,7,2.6,0,0,TAU); ctx.fill();
  ctx.fillStyle='#20262b';
  ctx.beginPath(); ctx.arc(-5,-1.5,1.6,0,TAU); ctx.fill();
  ctx.fillStyle='rgba(255,255,255,0.9)';
  ctx.beginPath(); ctx.arc(-5.6,-2.1,0.6,0,TAU); ctx.fill();
  ctx.restore();
}
// The shark — the most detailed sprite, built entirely from code paths.
// Drawn in LOCAL coordinates facing right, then positioned by translate +
// rotate (pitch while alive, the belly-up rot when dead) and scaled ~1.1x
// with a small pulse right after a bite. Parts, back to front:
//   caudal fin (wagging on its own hinge) -> dorsal fin -> body -> belly
//   -> pectoral fin -> gills -> eye -> mouth.
// The belly is an ellipse CLIPPED to the body path, so it can never poke
// outside the silhouette no matter how the body deforms.
// The mouth has two states: a thin closed-smile line below 10% openness,
// and above that an open dark wedge with three white teeth whose length
// follows m — so the jaw visibly widens as it locks onto food.
function drawShark(){
  const dying=(S.state==='dying'||S.state==='over');
  ctx.save();
  ctx.translate(shark.x,shark.y);
  ctx.rotate(dying?shark.rot:shark.pitch);
  const s=1.1*(1+shark.bite*0.06);
  ctx.scale(s,s);
  const bodyC='#8fa3ad', bellyC='#dfe9ec', finC='#79909b';
  // caudal fin (wagging)
  ctx.save();
  ctx.translate(-42,0);
  ctx.rotate(Math.sin(shark.tail)*0.35);
  ctx.fillStyle=finC;
  ctx.beginPath();
  ctx.moveTo(2,-2);
  ctx.quadraticCurveTo(-16,-10,-24,-30);
  ctx.quadraticCurveTo(-14,-8,-8,-3);
  ctx.quadraticCurveTo(-14,2,-20,16);
  ctx.quadraticCurveTo(-8,6,2,3);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
  // dorsal fin
  ctx.fillStyle=finC;
  ctx.beginPath();
  ctx.moveTo(-14,-12);
  ctx.quadraticCurveTo(-6,-30,4,-32);
  ctx.quadraticCurveTo(0,-20,6,-13);
  ctx.closePath();
  ctx.fill();
  // body
  ctx.fillStyle=bodyC;
  ctx.beginPath();
  ctx.moveTo(52,2);
  ctx.quadraticCurveTo(34,-16,2,-18);
  ctx.quadraticCurveTo(-30,-17,-46,-3);
  ctx.quadraticCurveTo(-30,12,0,15);
  ctx.quadraticCurveTo(32,15,52,2);
  ctx.closePath();
  ctx.fill();
  // belly (clipped to body silhouette)
  ctx.save();
  ctx.clip();
  ctx.fillStyle=bellyC;
  ctx.beginPath();
  ctx.ellipse(2,13,48,11,0,0,TAU);
  ctx.fill();
  ctx.restore();
  // pectoral fin
  ctx.save();
  ctx.translate(6,8);
  ctx.rotate(0.5+Math.sin(shark.tail*0.7)*0.12);
  ctx.fillStyle=finC;
  ctx.beginPath();
  ctx.moveTo(0,0);
  ctx.quadraticCurveTo(-14,10,-22,22);
  ctx.quadraticCurveTo(-8,12,2,4);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
  // gills
  ctx.strokeStyle='rgba(40,60,70,0.55)';
  ctx.lineWidth=2;
  for(let k=0;k<3;k++){
    ctx.beginPath();
    ctx.moveTo(16+k*6,-6);
    ctx.quadraticCurveTo(13+k*6,0,16+k*6,6);
    ctx.stroke();
  }
  // eye
  ctx.fillStyle='#f4f8f8';
  ctx.beginPath(); ctx.arc(30,-7,4.4,0,TAU); ctx.fill();
  ctx.fillStyle='#10181d';
  ctx.beginPath(); ctx.arc(31.4,-7,2.3,0,TAU); ctx.fill();
  ctx.fillStyle='rgba(255,255,255,0.9)';
  ctx.beginPath(); ctx.arc(30.6,-8,0.9,0,TAU); ctx.fill();
  // mouth
  // m = final openness: the proximity target plus the bite impulse, clamped.
  const m=clamp(shark.mouth+shark.bite,0,1);
  if(m<0.1){
    ctx.strokeStyle='rgba(30,45,55,0.7)';
    ctx.lineWidth=2;
    ctx.beginPath();
    ctx.moveTo(50,4);
    ctx.quadraticCurveTo(42,8,34,8);
    ctx.stroke();
  }else{
    ctx.fillStyle='#132028';
    ctx.beginPath();
    ctx.moveTo(52,2);
    ctx.quadraticCurveTo(44,3,34,5);
    ctx.quadraticCurveTo(40,6+16*m,48,8+13*m);
    ctx.quadraticCurveTo(52,6+6*m,53,3);
    ctx.closePath();
    ctx.fill();
    // three white teeth hanging from the upper lip, sized by m
    ctx.fillStyle='#f2f6f6';
    for(let k=0;k<3;k++){
      const tx=38+k*5, ty=4.6+k*0.4;
      ctx.beginPath();
      ctx.moveTo(tx,ty); ctx.lineTo(tx+2.4,ty); ctx.lineTo(tx+1.2,ty+3.4*m);
      ctx.closePath(); ctx.fill();
    }
  }
  ctx.restore();
}
// Particles — one render style per type, matching the physics in
// updateWorld: bubbles are stroked circles, glow motes are additive
// ('lighter') soft dots that shrink as they fade, blood is an expanding
// translucent red cloud, and everything else ('bit') is a solid dot in
// its own colour. Alpha always = remaining life / max life.
function drawParticles(){
  for(const p of parts){
    const a=clamp(p.life/p.max,0,1);
    if(p.type==='bubble'){
      ctx.strokeStyle='rgba(214,242,240,'+(0.45*a)+')';
      ctx.lineWidth=1.4;
      ctx.beginPath(); ctx.arc(p.x,p.y,p.size,0,TAU); ctx.stroke();
    }else if(p.type==='glow'){
      ctx.save();
      ctx.globalCompositeOperation='lighter';
      ctx.fillStyle='rgba(122,240,224,'+(0.55*a)+')';
      ctx.beginPath(); ctx.arc(p.x,p.y,p.size*(0.6+a*0.7),0,TAU); ctx.fill();
      ctx.restore();
    }else if(p.type==='blood'){
      ctx.fillStyle='rgba(232,58,48,'+(0.34*a)+')';
      ctx.beginPath(); ctx.arc(p.x,p.y,p.size*(1+(1-a)*1.6),0,TAU); ctx.fill();
    }else{
      ctx.fillStyle='rgba('+p.col[0]+','+p.col[1]+','+p.col[2]+','+a+')';
      ctx.beginPath(); ctx.arc(p.x,p.y,p.size,0,TAU); ctx.fill();
    }
  }
}
// Floating "+1" texts: Bungee font, dark outline (strokeText) for
// readability over the water, coral fill, fading as they rise.
function drawPopups(){
  if(!pops.length) return;
  ctx.save();
  ctx.font='20px Bungee, sans-serif';
  ctx.textAlign='center';
  ctx.textBaseline='middle';
  for(const p of pops){
    const a=clamp(p.life/p.max,0,1);
    ctx.lineWidth=4;
    ctx.strokeStyle='rgba(2,12,16,'+(0.55*a)+')';
    ctx.strokeText(p.txt,p.x,p.y);
    ctx.fillStyle='rgba(255,122,96,'+a+')';
    ctx.fillText(p.txt,p.x,p.y);
  }
  ctx.restore();
}
// The water surface at the very top: a translucent band with a wavy bottom
// edge plus a brighter wave line, so the player can always read which way
// is "up". It fades almost entirely in the abyss — no surface light down there.
function drawSurface(){
  const a=1-S.depthT*0.75;
  ctx.fillStyle='rgba(190,235,228,'+(0.16*a)+')';
  ctx.beginPath();
  ctx.moveTo(0,0); ctx.lineTo(W,0); ctx.lineTo(W,24);
  for(let x=W;x>=0;x-=28)
    ctx.lineTo(x,24+Math.sin((x+S.worldX*1.4)*0.02)*5);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle='rgba(225,250,246,'+(0.30*a)+')';
  ctx.lineWidth=2;
  ctx.beginPath();
  for(let x=W;x>=0;x-=28){
    const y=24+Math.sin((x+S.worldX*1.4)*0.02)*5;
    if(x===W) ctx.moveTo(x,y); else ctx.lineTo(x,y);
  }
  ctx.stroke();
}
// Soft dark vignette around the screen edges, focusing the eye inward.
// The gradient object is cached in `vign` and only rebuilt on resize.
function drawVignette(){
  if(!vign){
    vign=ctx.createRadialGradient(W/2,H*0.45,Math.min(W,H)*0.35,W/2,H*0.5,Math.max(W,H)*0.75);
    vign.addColorStop(0,'rgba(1,8,12,0)');
    vign.addColorStop(1,'rgba(1,8,12,0.42)');
  }
  ctx.fillStyle=vign;
  ctx.fillRect(0,0,W,H);
}
// Master render. Order IS the look — later calls draw on top:
//   water -> rays -> dunes -> silhouettes -> snow -> sand -> kelp
//   -> hazards -> fish -> shark -> particles -> popups -> surface
// Everything above runs inside a screen-shake translate. Then, OUTSIDE the
// shaken transform: a brief red flash on death, and the vignette.
function draw(){
  const sx=(Math.random()*2-1)*S.shake;
  const sy=(Math.random()*2-1)*S.shake;
  ctx.save();
  ctx.translate(sx,sy);
  drawWater();
  drawRays();
  drawDunes();
  drawSilhouettes();
  drawSnow();
  drawSand();
  drawKelp();
  for(const h of hazards) drawHazard(h);
  for(const f of fish) drawFish(f);
  drawShark();
  drawParticles();
  drawPopups();
  drawSurface();
  ctx.restore();
  if(S.state==='dying'&&S.deathTimer<0.28){
    ctx.fillStyle='rgba(255,64,48,'+((0.28-S.deathTimer)*1.1)+')';
    ctx.fillRect(0,0,W,H);
  }
  drawVignette();
}

/* ================= hud + main loop ================= */
// Depth meter: 1 metre per 50 px scrolled. The DOM is only written when
// the rounded value CHANGES (lastDepth cache) — not on every frame.
function updateHUD(){
  const dm=Math.floor(S.runDist/50);
  if(dm!==lastDepth){ lastDepth=dm; depthEl.textContent='DEPTH '+dm+' M'; }
}
// Timestamp of the previous frame, for the delta-time calculation.
let last=performance.now();
// THE main loop, driven by requestAnimationFrame. Per frame:
//   1. rdt = real elapsed seconds, CLAMPED to 33 ms so a tab-switch spike
//      can never tunnel objects through each other
//   2. 'paused' freezes everything (early return — the canvas keeps its
//      last painted frame behind the pause overlay)
//   3. 'dying' runs the slow-motion ramp: timescale eases toward 0.12, and
//      after 1.15 REAL seconds the game-over screen takes over
//   4. any other state eases the timescale back to normal speed
//   5. dt = rdt * timescale is what the simulation actually consumes
//   6. update shark + world, collide (playing only), decay shake,
//      repaint, refresh the HUD
function frame(now){
  requestAnimationFrame(frame);
  const rdt=Math.min(0.033,(now-last)/1000);
  last=now;
  if(S.state==='paused') return;
  S.t+=rdt;
  if(S.state==='dying'){
    S.deathTimer+=rdt;
    S.timescale+=(0.12-S.timescale)*Math.min(1,rdt*5);
    if(S.deathTimer>1.15) gameOver();
  }else{
    S.timescale+=(1-S.timescale)*Math.min(1,rdt*8);
  }
  const dt=rdt*S.timescale;
  updateShark(dt);
  updateWorld(dt);
  if(S.state==='playing') collide();
  S.shake=Math.max(0,S.shake-rdt*26);
  draw();
  updateHUD();
}

/* ================= init ================= */
// One-time setup of the ambient layers (re-seedable, but only called once).
function initSnow(){
  snow.length=0;
  for(let i=0;i<60;i++)
    snow.push({x:rand(0,W),y:rand(0,H),v:rand(5,16),r:rand(0.7,1.6)});
}
function initSilh(){
  silh.length=0;
  for(let i=0;i<7;i++)
    silh.push({x:rand(0,W),y:rand(70,Math.max(120,H-180)),s:rand(0.5,1.2),v:rand(6,18),ph:rand(0,TAU)});
}
// Boot sequence: size the canvas, seed the background layers, park the
// shark at its menu cruise position, fill the best-score line from
// localStorage, set the correct mute icon, pre-load the Bungee font so
// canvas pop-up text renders with it immediately, and start the loop.
resize();
initSnow();
initSilh();
shark.x=Math.max(70,W*0.24);
shark.y=H*0.46;
menuBestEl.textContent=S.best>0?'BEST · '+S.best+' FISH':'FIRST DIVE — NO RECORD YET';
icoOn.classList.toggle('hidden',S.muted);
icoOff.classList.toggle('hidden',!S.muted);
if(document.fonts&&document.fonts.load) document.fonts.load('20px Bungee');
requestAnimationFrame(frame);
