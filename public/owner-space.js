(function () {
  const style = document.createElement('style');
  style.textContent = `
    #ownerStudioLauncher{position:fixed;bottom:22px;left:22px;z-index:1200;border:1px solid #8c6285;border-radius:50px;padding:12px 18px;background:linear-gradient(135deg,#472d48,#302237);color:#ffeafa;box-shadow:0 10px 30px #120a166e;cursor:pointer;transition:transform .2s,box-shadow .2s;font:700 14px Tajawal,sans-serif}
    #ownerStudioLauncher:hover{transform:translateY(-3px);box-shadow:0 14px 34px #120a1690}
    #ownerStudioPanel{position:fixed;inset:0;z-index:1300;display:none;overflow:auto;padding:clamp(14px,3vw,34px);background:#f5efe5;color:#342b27;isolation:isolate}
    #ownerStudioPanel.open{display:block;animation:ownerPageIn .32s ease both}
    @keyframes ownerPageIn{from{opacity:0}to{opacity:1}}
    .owner-profile-page{position:relative;z-index:1;width:min(100%,1240px);min-height:100%;margin:auto}
    .owner-butterfly-garden{position:fixed;inset:0;z-index:0;overflow:hidden;pointer-events:none}
    .owner-butterfly-flight{position:absolute;display:block;width:clamp(34px,4vw,54px);aspect-ratio:1;opacity:.24;filter:drop-shadow(0 5px 12px #71598b25);will-change:transform}
    .owner-butterfly-flight img{display:block;width:100%;height:100%;object-fit:contain;animation:ownerGardenWings .42s ease-in-out infinite alternate}
    .owner-butterfly-flight--one{left:-7vw;top:73vh;animation:ownerGardenFlightOne 24s ease-in-out -7s infinite}
    .owner-butterfly-flight--two{left:87vw;top:68vh;animation:ownerGardenFlightTwo 28s ease-in-out -16s infinite}
    .owner-butterfly-flight--three{left:9vw;top:18vh;width:clamp(28px,3vw,42px);opacity:.19;animation:ownerGardenFlightThree 32s ease-in-out -22s infinite}
    @keyframes ownerGardenFlightOne{0%,100%{transform:translate3d(0,0,0) rotate(-12deg)}22%{transform:translate3d(18vw,-16vh,0) rotate(10deg)}48%{transform:translate3d(42vw,-36vh,0) rotate(-8deg)}73%{transform:translate3d(70vw,-20vh,0) rotate(12deg)}90%{transform:translate3d(94vw,-49vh,0) rotate(-5deg)}}
    @keyframes ownerGardenFlightTwo{0%,100%{transform:translate3d(0,0,0) rotate(12deg)}24%{transform:translate3d(-18vw,-21vh,0) rotate(-8deg)}51%{transform:translate3d(-44vw,-40vh,0) rotate(10deg)}77%{transform:translate3d(-70vw,-18vh,0) rotate(-12deg)}92%{transform:translate3d(-94vw,-48vh,0) rotate(6deg)}}
    @keyframes ownerGardenFlightThree{0%,100%{transform:translate3d(0,0,0) rotate(-8deg)}30%{transform:translate3d(19vw,12vh,0) rotate(10deg)}58%{transform:translate3d(38vw,35vh,0) rotate(-9deg)}82%{transform:translate3d(60vw,22vh,0) rotate(11deg)}}
    @keyframes ownerGardenWings{from{transform:scaleX(.94) rotate(-1.5deg)}to{transform:scaleX(1.04) rotate(1.5deg)}}
    .owner-page-top{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:18px}
    .owner-back{display:inline-flex;align-items:center;gap:9px;padding:10px 14px;border:1px solid #dfd2be;border-radius:12px;background:#fffaf2;color:#574437;font:700 14px Tajawal,sans-serif;cursor:pointer;transition:transform .2s,box-shadow .2s}
    .owner-back:hover{transform:translateY(-2px);box-shadow:0 8px 18px #6e4e231c}
    .owner-page-mark{display:flex;align-items:center;gap:9px;color:#78684f;font:700 11px Tajawal,sans-serif;letter-spacing:.06em}
    .owner-page-secure{display:inline-flex;align-items:center;gap:6px;padding:7px 10px;border:1px solid #d7c598;border-radius:30px;background:#fbf5e6;color:#80642a;letter-spacing:0}
    .owner-profile-hero{position:relative;display:flex;align-items:flex-end;gap:24px;min-height:300px;overflow:hidden;padding:clamp(24px,5vw,54px);border:1px solid #c6a96b;border-radius:28px;background:linear-gradient(115deg,#352c3b 0%,#63505c 40%,#bd9072 72%,#e8c891 100%);color:#fffaf2;isolation:isolate;box-shadow:0 20px 55px #49341d24;transition:background 1.8s ease,border-color 1.8s ease}
    .owner-profile-hero:before{content:"";position:absolute;inset:0;z-index:-1;background:radial-gradient(ellipse at 20% 90%,#ffd98988,transparent 45%),linear-gradient(180deg,#fff5dc08 0%,transparent 52%,#21152655 100%);transition:background 1.8s ease}
    .owner-hero-stars{position:absolute;inset:0;z-index:-1;opacity:.35;background-image:radial-gradient(1px 1px at 14% 25%,#fff 98%,transparent),radial-gradient(1px 1px at 55% 19%,#fff 98%,transparent),radial-gradient(1.5px 1.5px at 84% 32%,#fff 98%,transparent),radial-gradient(1px 1px at 68% 58%,#fff 98%,transparent);background-size:230px 150px;animation:ownerStarDrift 16s linear infinite;transition:opacity 1.8s ease}
    @keyframes ownerStarDrift{to{background-position:0 -150px}}
    .owner-profile-hero.is-night{border-color:#8077a9;background:linear-gradient(115deg,#151a36 0%,#292e55 42%,#51436a 75%,#79556d 100%)}
    .owner-profile-hero.is-night:before{background:radial-gradient(ellipse at 24% 88%,#8ea7e044,transparent 48%),radial-gradient(ellipse at 83% 12%,#c7a7e033,transparent 40%),linear-gradient(180deg,#11152b40 0%,transparent 50%,#10142e70 100%)}
    .owner-profile-hero.is-night .owner-hero-stars{opacity:.96;animation:ownerStarDrift 22s linear infinite,ownerNightTwinkle 4.5s ease-in-out infinite alternate}
    .owner-profile-hero.is-night .owner-hero-stars:after{content:"";position:absolute;inset:0;background-image:radial-gradient(2px 2px at 23% 19%,#fff9d7 98%,transparent),radial-gradient(1.5px 1.5px at 39% 53%,#fff 98%,transparent),radial-gradient(2px 2px at 74% 37%,#e7ddff 98%,transparent),radial-gradient(1.5px 1.5px at 91% 68%,#fff3c2 98%,transparent);background-size:310px 210px;animation:ownerStarDrift 28s linear infinite,ownerStarBlink 3.1s ease-in-out infinite alternate}
    @keyframes ownerNightTwinkle{from{opacity:.66}to{opacity:1}}
    @keyframes ownerStarBlink{from{opacity:.35;transform:scale(.99)}to{opacity:1;transform:scale(1.01)}}
    .owner-hero-horizon{position:absolute;left:0;right:0;bottom:0;height:70px;z-index:-1;background:linear-gradient(180deg,transparent,#f8d79755 72%,#f0d4a8aa);clip-path:polygon(0 60%,18% 48%,34% 68%,55% 40%,73% 62%,100% 35%,100% 100%,0 100%);transition:background 1.8s ease}
    .owner-profile-hero.is-night .owner-hero-horizon{background:linear-gradient(180deg,transparent,#9c8bb344 45%,#3a426fbb 100%)}
    .owner-hero-sun{position:absolute;left:19%;bottom:-26px;z-index:0;width:76px;height:76px;opacity:0;filter:drop-shadow(0 0 24px #ffde987a) drop-shadow(0 0 62px #ffdd8255)}
    .owner-hero-sun img{display:block;width:100%;height:100%}
    #ownerStudioPanel.open .owner-hero-sun{animation:profileSunRise 1.35s cubic-bezier(.2,.8,.2,1) .12s forwards}
    .owner-profile-hero.is-night .owner-hero-sun{animation:none!important;opacity:0!important}
    @keyframes profileSunRise{0%{opacity:0;transform:translate3d(-22px,55px,0) scale(.72)}55%{opacity:1;transform:translate3d(20px,-26px,0) scale(1.04)}78%{transform:translate3d(33px,-49px,0) scale(.98)}100%{opacity:1;transform:translate3d(42px,-43px,0) scale(1)}}
    .owner-hero-moon{position:absolute;left:20%;top:18%;z-index:0;width:74px;height:74px;opacity:0;filter:drop-shadow(0 0 19px #fff0be88) drop-shadow(0 0 48px #c6c7ff44)}
    .owner-hero-moon img{display:block;width:100%;height:100%;animation:ownerMoonFloat 6.5s ease-in-out 1s infinite alternate}
    .owner-profile-hero.is-night .owner-hero-moon{animation:profileMoonRise .9s cubic-bezier(.2,.8,.2,1) .12s both}
    @keyframes profileMoonRise{from{opacity:0;transform:translate3d(-18px,24px,0) scale(.72)}to{opacity:1;transform:translate3d(0,0,0) scale(1)}}
    @keyframes ownerMoonFloat{from{transform:translateY(-3px) rotate(-3deg)}to{transform:translateY(4px) rotate(3deg)}}
    .owner-profile-avatar{position:relative;z-index:1;display:grid;place-items:center;flex:0 0 112px;width:112px;height:112px;overflow:hidden;border:3px solid #fff9e5;border-radius:50%;background:#f4e2c0;color:#765327;font:800 38px Tajawal,sans-serif;box-shadow:0 0 0 7px #fff2d52e,0 12px 30px #2117253b}
    .owner-profile-avatar img{width:100%;height:100%;object-fit:cover}
    .owner-hero-copy{position:relative;z-index:1;min-width:0}
    .owner-hero-eyebrow{font:700 11px Tajawal,sans-serif;letter-spacing:.16em;color:#ffe9bf}
    .owner-hero-name{margin:5px 0 2px;font:800 clamp(30px,5vw,48px) Tajawal,sans-serif;letter-spacing:.015em;text-shadow:0 4px 16px #22172355;animation:ownerNameArrive .65s cubic-bezier(.2,.8,.2,1) both}
    @keyframes ownerNameArrive{from{opacity:0;transform:translateY(12px);letter-spacing:.08em}to{opacity:1;transform:none;letter-spacing:.015em}}
    .owner-hero-subtitle{margin:0;color:#fff1d7;font:500 14px Tajawal,sans-serif}
    .owner-hero-badges{display:flex;flex-wrap:wrap;gap:8px;margin-top:15px}
    .owner-hero-badge{display:inline-flex;align-items:center;gap:6px;padding:7px 11px;border:1px solid #fff6df50;border-radius:99px;background:#291f2b33;color:#fff8e8;font:600 12px Tajawal,sans-serif;backdrop-filter:blur(8px)}
    .owner-sky-status{font-variant-numeric:tabular-nums}
    .owner-sky-status time{direction:ltr;unicode-bidi:isolate;opacity:.9}
    .owner-profile-actions{position:absolute;top:22px;left:22px;z-index:2;display:flex;gap:8px}
    .owner-profile-action{display:inline-flex;align-items:center;gap:7px;padding:10px 13px;border:1px solid #fff4dc77;border-radius:12px;background:#291f2b37;color:#fffaf0;font:700 12px Tajawal,sans-serif;cursor:pointer;backdrop-filter:blur(8px);transition:background .2s,transform .2s}
    .owner-profile-action:hover{background:#291f2b65;transform:translateY(-2px)}
    .owner-profile-main{padding:26px 0 52px}
    .owner-profile-heading{display:flex;align-items:end;justify-content:space-between;gap:16px;margin:0 2px 15px}
    .owner-profile-heading h2{margin:0;color:#3c302a;font:800 22px Tajawal,sans-serif}
    .owner-profile-heading p{margin:4px 0 0;color:#817364;font:500 13px Tajawal,sans-serif}
    .owner-feature-grid{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(300px,.85fr);gap:16px;align-items:start}
    .owner-feature-card{min-width:0;padding:20px;border:1px solid #e4d8c5;border-radius:20px;background:#fffdf9;box-shadow:0 7px 25px #4e382018;animation:ownerCardIn .45s ease both}
    .owner-feature-card:nth-child(2){animation-delay:.08s}
    @keyframes ownerCardIn{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}
    .owner-card-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px;color:#453831;font:800 16px Tajawal,sans-serif}
    .owner-card-icon{display:grid;place-items:center;width:36px;height:36px;border-radius:12px;background:#f7efe1;color:#96702d;font-size:17px}
    .owner-studio-grid{display:grid;grid-template-columns:1.2fr .8fr;gap:13px}
    .owner-studio-box{min-width:0;padding:14px;border:1px solid #eee4d5;border-radius:15px;background:#fffaf2}
    .owner-note-row{padding:12px 14px;background:#fff;border:1px solid #eadfcd;border-radius:13px;margin-top:9px;white-space:pre-wrap;color:#51443d;box-shadow:0 3px 10px #52381508}
    .owner-input{width:100%;padding:10px 12px;border:1px solid #e1d4c1;border-radius:11px;background:#fff;color:#342b27;font:500 14px Tajawal,sans-serif;margin-top:8px;outline:none;transition:border-color .2s,box-shadow .2s}
    .owner-input:focus{border-color:#bd984e;box-shadow:0 0 0 3px #d8b96125}
    .owner-calc{font:600 25px 'JetBrains Mono',monospace;direction:ltr;text-align:right;background:#29232c;color:#fff3d7;border-color:#29232c}
    .owner-keys{display:grid;grid-template-columns:repeat(4,1fr);gap:7px;margin-top:9px}
    .owner-keys button{min-height:42px;border-radius:10px;background:#f5eee3;color:#493b32;border:1px solid #e4d9c8;font-size:16px;cursor:pointer;transition:transform .15s,background .15s}
    .owner-keys button:hover{background:#ebddc5;transform:translateY(-1px)}
    .owner-keys .op{background:#e8d7b6;color:#59451e;font-weight:800}
    .owner-small{font-size:12px;color:#857768;line-height:1.7}
    .owner-sound-row{display:flex;align-items:center;gap:12px;margin-top:16px;padding-top:14px;border-top:1px solid #eee4d5}
    .owner-sound-row>div{flex:1;min-width:0}
    .owner-profile-footer{margin-top:18px;text-align:center;color:#958674;font:500 11px Tajawal,sans-serif}
    @media(max-width:800px){.owner-profile-hero{min-height:290px}.owner-feature-grid{grid-template-columns:1fr}.owner-studio-grid{grid-template-columns:1fr 1fr}}
    @media(max-width:560px){#ownerStudioPanel{padding:10px}.owner-profile-hero{display:block;min-height:390px;padding:25px 20px 27px;border-radius:22px}.owner-profile-actions{top:14px;left:14px}.owner-profile-action{padding:8px 10px}.owner-profile-avatar{width:82px;height:82px;margin-top:72px;font-size:30px}.owner-hero-name{font-size:34px}.owner-hero-sun{left:56%}.owner-page-mark{font-size:9px}.owner-studio-grid{grid-template-columns:1fr}.owner-feature-card{padding:14px}.owner-profile-heading h2{font-size:19px}}
    @media(prefers-reduced-motion:reduce){#ownerStudioPanel.open,.owner-profile-hero *, .owner-profile-hero .owner-hero-stars:after,.owner-feature-card,.owner-hero-name,.owner-hero-stars,.owner-butterfly-flight,.owner-butterfly-flight img{animation:none!important;transition:none!important}.owner-profile-hero:not(.is-night) .owner-hero-sun{opacity:.9;transform:translate(42px,-43px)}.owner-profile-hero.is-night .owner-hero-sun{opacity:0!important}.owner-profile-hero.is-night .owner-hero-moon{opacity:1;transform:none}.owner-profile-hero.is-night .owner-hero-stars{opacity:.96}}
  `;
  document.head.appendChild(style);

  let cal = '0', stored = null, operator = null, fresh = false, returnFocus = null;
  let lastAlertKey = null;
  let skyTimer = null, skyVisibilityBound = false;
  const storageKey = (name) => `rifai:owner:${Number(state?.user?.id) || 'local'}:${name}`;
  function safe(value) {
    return String(value || '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  }
  function mount() {
    if (!state?.token || !state?.user || state.user.role !== 'owner' || document.getElementById('app')?.style.display === 'none') return;
    if (!document.getElementById('ownerStudioLauncher')) {
      const button = document.createElement('button');
      button.id = 'ownerStudioLauncher'; button.type = 'button'; button.textContent = '✦ مساحتي'; button.setAttribute('aria-label', 'افتح ملف المالك ومساحته الخاصة');
      button.addEventListener('click', openOwnerProfile); document.body.appendChild(button);
    }
    // يمكن أن يُستدعى mount مجددًا بعد تحديث بيانات المستخدم؛ لا تكرر عناصر الصفحة أو مستمعيها.
    if (document.getElementById('ownerStudioPanel')) return;

    const panel = document.createElement('div'); panel.id = 'ownerStudioPanel'; panel.setAttribute('aria-hidden', 'true');
    panel.innerHTML = `<div class="owner-butterfly-garden" aria-hidden="true"><span class="owner-butterfly-flight owner-butterfly-flight--one"><img src="/assets/owner-butterfly.png" alt=""></span><span class="owner-butterfly-flight owner-butterfly-flight--two"><img src="/assets/owner-butterfly.png" alt=""></span><span class="owner-butterfly-flight owner-butterfly-flight--three"><img src="/assets/owner-butterfly.png" alt=""></span></div><main class="owner-profile-page" role="dialog" aria-modal="true" aria-label="الملف الشخصي الخاص بالمالك">
      <header class="owner-page-top"><button type="button" class="owner-back" id="ownerStudioClose"><span aria-hidden="true">←</span> العودة للنظام</button><div class="owner-page-mark"><span>AL-RIFAI · PRIVATE SPACE</span><span class="owner-page-secure">✦ مساحة خاصة ومحمية</span></div></header>
      <section class="owner-profile-hero" aria-label="الملف الشخصي">
        <div class="owner-hero-stars" aria-hidden="true"></div><div class="owner-hero-sun" aria-hidden="true"><img src="/assets/owner-sun.svg" alt=""></div><div class="owner-hero-moon" aria-hidden="true"><img src="/assets/owner-moon.svg" alt=""></div><div class="owner-hero-horizon" aria-hidden="true"></div>
        <div class="owner-profile-actions"><button type="button" class="owner-profile-action" id="ownerProfileSettings"><span aria-hidden="true">⚙</span> الملف والإعدادات</button></div>
        <div class="owner-profile-avatar" id="ownerProfileAvatar" aria-label="الصورة الشخصية">م</div>
        <div class="owner-hero-copy"><div class="owner-hero-eyebrow">مساحتك الخاصة</div><h1 class="owner-hero-name" id="ownerProfileName">المالك</h1><p class="owner-hero-subtitle">ملفك الشخصي وأدواتك اليومية في مكان واحد</p><div class="owner-hero-badges"><span class="owner-hero-badge">✦ مالك المشروع</span><span class="owner-hero-badge">✓ تحقق بخطوتين مفعّل</span><span class="owner-hero-badge owner-sky-status" id="ownerSkyStatus"><span id="ownerSkyIcon" aria-hidden="true">☀</span><span id="ownerSkyLabel">النهار</span><time id="ownerSkyTime"></time></span></div></div>
      </section>
      <section class="owner-profile-main"><div class="owner-profile-heading"><div><h2>مساحتك</h2><p id="ownerSkyDescription">ملاحظاتك وأدواتك المفضلة، بتصميم هادئ وإضاءة شروق دافئة.</p></div></div>
        <div class="owner-feature-grid">
          <section class="owner-feature-card"><div class="owner-card-heading"><span style="display:flex;align-items:center;gap:10px"><span class="owner-card-icon" aria-hidden="true">✎</span> ملاحظاتي</span><button class="btn btn-primary btn-sm" id="ownerNewNote">＋ ملاحظة جديدة</button></div>
            <div class="owner-studio-box"><label class="owner-small" for="ownerNoteTitle">عنوان الملاحظة</label><input class="owner-input" id="ownerNoteTitle" maxlength="160" placeholder="عنوان واضح لملاحظتك"><label class="owner-small" for="ownerNoteBody" style="display:block;margin-top:10px">النص</label><textarea class="owner-input" id="ownerNoteBody" maxlength="20000" rows="3" placeholder="اكتبي فكرة أو تذكيرًا..."></textarea><button class="btn btn-subtle btn-sm" id="ownerSaveNote" style="margin-top:9px">حفظ الملاحظة</button></div><div id="ownerNotes" style="margin-top:11px"></div>
          </section>
          <section class="owner-feature-card"><div class="owner-card-heading"><span style="display:flex;align-items:center;gap:10px"><span class="owner-card-icon" aria-hidden="true">＋</span> آلة حاسبة</span></div><section class="owner-studio-box" aria-label="آلة حاسبة بسيطة"><input class="owner-input owner-calc" id="ownerCalc" value="0" readonly aria-label="نتيجة العملية الحسابية"><div class="owner-keys">${['C','⌫','÷','×','7','8','9','−','4','5','6','+','1','2','3','=','0','.','00','%'].map(k => `<button type="button" class="${['÷','×','−','+','='].includes(k) ? 'op' : ''}" data-calc="${k}" aria-label="${k}">${k}</button>`).join('')}</div></section>
            <div class="owner-sound-row"><span class="owner-card-icon" aria-hidden="true">♫</span><div><strong>نغمة التنبيه</strong><div class="owner-small">اختاري صوتًا من جهازك واسمعي معاينته.</div></div></div><input type="file" id="ownerSoundFile" accept="audio/*" class="owner-input" aria-label="اختيار نغمة التنبيه"><audio id="ownerSoundPreview" controls style="width:100%;margin-top:8px;display:none" aria-label="معاينة صوت التنبيه"></audio><label class="owner-small" style="display:flex;align-items:center;gap:8px;margin-top:8px"><input type="checkbox" id="ownerSoundEnabled"> تشغيل الصوت عند وصول تنبيه جديد</label>
          </section>
        </div><div class="owner-profile-footer">ملف خاص بهذا الحساب · يتم حفظ الملاحظات في مساحة المالك</div>
      </section>
    </main>`;
    document.body.appendChild(panel);
    panel.querySelector('#ownerStudioClose').addEventListener('click', closeOwnerProfile);
    panel.querySelector('#ownerProfileSettings').addEventListener('click', () => { closeOwnerProfile(); window.openAccountSettings?.(); });
    panel.addEventListener('click', event => { if (event.target === panel) closeOwnerProfile(); });
    panel.querySelector('#ownerNewNote').addEventListener('click', () => panel.querySelector('#ownerNoteTitle').focus());
    panel.querySelector('#ownerSaveNote').addEventListener('click', saveNote);
    panel.querySelectorAll('[data-calc]').forEach(key => key.addEventListener('click', () => calcKey(key.dataset.calc)));
    panel.querySelector('#ownerSoundFile').addEventListener('change', selectSound);
    for (const [oldKey, newKey] of [['ownerSoundData','soundData'],['ownerSoundEnabled','soundEnabled']]) {
      if (localStorage.getItem(storageKey(newKey)) === null && localStorage.getItem(oldKey) !== null) localStorage.setItem(storageKey(newKey), localStorage.getItem(oldKey));
      localStorage.removeItem(oldKey);
    }
    const savedSound = localStorage.getItem(storageKey('soundData'));
    if (savedSound) { const audio = panel.querySelector('#ownerSoundPreview'); audio.src = savedSound; audio.style.display = 'block'; }
    const soundCheck = panel.querySelector('#ownerSoundEnabled');
    soundCheck.checked = localStorage.getItem(storageKey('soundEnabled')) === 'true';
    soundCheck.addEventListener('change', () => localStorage.setItem(storageKey('soundEnabled'), String(soundCheck.checked)));
    document.addEventListener('keydown', handleProfileKeydown);
    window.addEventListener('storage', handleOwnerStorage);
    startOwnerSkyClock();
    window.mountOwnerStudio = mount;
  }
  function updateOwnerSky() {
    const hero = document.querySelector('#ownerStudioPanel .owner-profile-hero');
    if (!hero) return;
    const now = new Date();
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Africa/Cairo';
    const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hourCycle: 'h23' }).format(now));
    const isDay = hour >= 6 && hour < 18;
    hero.classList.toggle('is-night', !isDay);
    const label = document.getElementById('ownerSkyLabel');
    const icon = document.getElementById('ownerSkyIcon');
    const time = document.getElementById('ownerSkyTime');
    const description = document.getElementById('ownerSkyDescription');
    if (label) label.textContent = isDay ? 'النهار' : 'الليل';
    if (icon) icon.textContent = isDay ? '☀' : '☾';
    if (description) description.textContent = isDay
      ? 'مساحة هادئة بإضاءة نهارية دافئة وفراشات رقيقة.'
      : 'مساحة ليلية هادئة بقمر مبتسم ونجوم متلألئة وفراشات رقيقة.';
    if (time) {
      time.textContent = new Intl.DateTimeFormat('ar-EG', { timeZone, hour: 'numeric', minute: '2-digit' }).format(now);
      time.dateTime = now.toISOString();
    }
  }
  function scheduleOwnerSkyUpdate() {
    clearTimeout(skyTimer);
    skyTimer = setTimeout(() => { updateOwnerSky(); scheduleOwnerSkyUpdate(); }, 60000 - (Date.now() % 60000) + 30);
  }
  function startOwnerSkyClock() {
    updateOwnerSky();
    scheduleOwnerSkyUpdate();
    if (!skyVisibilityBound) {
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) { updateOwnerSky(); scheduleOwnerSkyUpdate(); }
      });
      skyVisibilityBound = true;
    }
  }
  function updateProfileIdentity() {
    const user = state?.user || {};
    const name = document.getElementById('ownerProfileName');
    const avatar = document.getElementById('ownerProfileAvatar');
    if (name) name.textContent = window.normalizeUserDisplayName?.(user.full_name) || user.full_name || 'المالك';
    if (avatar) window.renderUserAvatar?.(avatar, user);
  }
  function openOwnerProfile() {
    if (state?.user?.role !== 'owner') return;
    if (!document.getElementById('ownerStudioPanel')) mount();
    const panel = document.getElementById('ownerStudioPanel');
    if (!panel) { toast('تعذر تجهيز مساحة المالك. حدّث الصفحة ثم حاول مرة أخرى.', 'danger'); return; }
    updateOwnerSky();
    returnFocus = document.activeElement;
    updateProfileIdentity(); panel.classList.add('open'); panel.setAttribute('aria-hidden', 'false');
    loadNotes(); panel.querySelector('#ownerStudioClose')?.focus({ preventScroll: true });
  }
  function closeOwnerProfile() {
    const panel = document.getElementById('ownerStudioPanel');
    if (!panel) return;
    panel.classList.remove('open'); panel.setAttribute('aria-hidden', 'true');
    if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
  }
  function handleProfileKeydown(event) { if (event.key === 'Escape' && document.getElementById('ownerStudioPanel')?.classList.contains('open')) closeOwnerProfile(); }
  function handleOwnerStorage() { if (state?.user?.role !== 'owner') { document.getElementById('ownerStudioLauncher')?.remove(); document.getElementById('ownerStudioPanel')?.remove(); } }
  async function saveNote() {
    const title = document.getElementById('ownerNoteTitle')?.value.trim();
    const body = document.getElementById('ownerNoteBody')?.value || '';
    if (!title) { document.getElementById('ownerNoteTitle')?.focus(); return; }
    try { await API.post('/owner-workspace/notes', { title, body, color: 'rose' }); document.getElementById('ownerNoteTitle').value = ''; document.getElementById('ownerNoteBody').value = ''; await loadNotes(); }
    catch (error) { toast(error.message, 'danger'); }
  }
  async function loadNotes() {
    const host = document.getElementById('ownerNotes'); if (!host) return;
    try {
      const { notes } = await API.get('/owner-workspace/notes');
      host.innerHTML = notes.length ? notes.map(note => `<article class="owner-note-row"><div style="display:flex;justify-content:space-between;align-items:center;gap:10px"><strong>${safe(note.title)}</strong><button type="button" class="btn btn-xs btn-subtle" data-delete-note="${Number(note.id)}" aria-label="حذف ${safe(note.title)}">حذف</button></div><div style="margin-top:7px;color:#6e5f54">${safe(note.body)}</div></article>`).join('') : '<div class="owner-small" style="padding:18px;text-align:center">مساحتك جاهزة لأول ملاحظة ✨</div>';
      host.querySelectorAll('[data-delete-note]').forEach(button => button.addEventListener('click', async () => { try { await API.delete('/owner-workspace/notes/' + button.dataset.deleteNote); await loadNotes(); } catch (error) { toast(error.message, 'danger'); } }));
    } catch (_) { host.innerHTML = '<div class="owner-small">تعذر تحميل الملاحظات الآن.</div>'; }
  }
  function selectSound(event) {
    const file = event.target.files?.[0]; if (!file) return;
    if (file.size > 2 * 1024 * 1024) { toast('حجم الصوت يجب ألا يتجاوز 2 ميجابايت', 'danger'); event.target.value = ''; return; }
    if (!file.type.startsWith('audio/')) { toast('اختاري ملفًا صوتيًا صالحًا', 'danger'); event.target.value = ''; return; }
    const reader = new FileReader();
    reader.onload = () => { try { localStorage.setItem(storageKey('soundData'), reader.result); const audio = document.getElementById('ownerSoundPreview'); audio.src = reader.result; audio.style.display = 'block'; audio.play().catch(() => {}); } catch (_) { toast('مساحة تخزين المتصفح غير كافية لحفظ هذا الملف', 'danger'); } };
    reader.readAsDataURL(file);
  }
  function calcKey(key) {
    const display = document.getElementById('ownerCalc'); if (!display) return;
    if (key === 'C') { cal = '0'; stored = null; operator = null; fresh = false; }
    else if (key === '⌫') cal = cal.length > 1 ? cal.slice(0, -1) : '0';
    else if (['+','−','×','÷'].includes(key)) { stored = Number(cal); operator = key; fresh = true; }
    else if (key === '=') { if (stored !== null && operator) { const a = stored, b = Number(cal); const value = operator === '+' ? a + b : operator === '−' ? a - b : operator === '×' ? a * b : b === 0 ? NaN : a / b; cal = Number.isFinite(value) ? String(Number(value.toFixed(8))) : 'خطأ'; stored = null; operator = null; fresh = true; } }
    else if (key === '%') cal = String(Number(cal) / 100);
    else if (cal === 'خطأ') cal = '0';
    else if (key === '.' && !fresh && cal.includes('.')) {}
    else { cal = fresh ? (key === '.' ? '0.' : key === '00' ? '0' : key) : cal === '0' ? (key === '.' ? '0.' : key === '00' ? '0' : key) : cal + (key === '00' ? '00' : key); fresh = false; }
    display.value = cal;
  }
  window.playOwnerNotificationSound = function (items) {
    if (!state?.user || state.user.role !== 'owner' || localStorage.getItem(storageKey('soundEnabled')) !== 'true') return;
    const source = localStorage.getItem(storageKey('soundData')); if (!source) return;
    const key = (items || []).map(item => item.id || item.sku || item.name).sort().join('|');
    if (lastAlertKey !== null && key !== lastAlertKey) { const audio = new Audio(source); audio.volume = .75; audio.play().catch(() => {}); }
    lastAlertKey = key;
  };
  window.openOwnerProfile = openOwnerProfile;
  window.mountOwnerStudio = mount;
  if (state?.user?.role === 'owner') setTimeout(mount, 0);
})();
