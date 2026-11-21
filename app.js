import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import { STR, QUIZ, ICEBREAKERS, PRIVACY } from "./i18n.js";

// ---------- config ----------
const SUPABASE_URL = "https://uhnxxafhjgkzvcwbgggz.supabase.co";
const SUPABASE_KEY = "sb_publishable_bXskVfmRkaR6NeIQoUqP1w_mecDOyqi"; // publishable key, safe in the browser
const SCHOOL_RE = /@([a-z0-9-]+\.)*(nthu|nycu)\.edu\.tw$/i;

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true },
});

// ---------- state ----------
const state = { session: null, profile: null, quiz: null, lang: loadLang() };

function loadLang() {
  let saved = null;
  try { saved = localStorage.getItem("ud_lang"); } catch {}
  if (saved === "en" || saved === "zh") return saved;
  return (navigator.language || "").toLowerCase().startsWith("zh") ? "zh" : "en";
}
function setLang(l) {
  state.lang = l;
  try { localStorage.setItem("ud_lang", l); } catch {}
  document.documentElement.lang = l === "zh" ? "zh-Hant" : "en";
  if (state.profile) sb.from("profiles").update({ lang: l }).eq("id", state.profile.id).then(() => {});
  render();
}
Object.assign(STR, {
  login_check_email: { en: "Almost there! We sent a confirmation link to your school email. Click it, then come back and sign in. (Check spam too.)", zh: "快好囉！驗證信已寄到你的學校信箱，點信裡的連結後，再回來登入就可以了。沒收到的話，也找一下垃圾郵件喔。" },
  login_not_confirmed: { en: "Please confirm your email first — check your school inbox (and spam) for the link.", zh: "先驗證信箱才能登入喔。到學校信箱找一下驗證信，垃圾郵件也記得看一下。" },
});
const t = (k) => (STR[k] ? STR[k][state.lang] : k);
const tt = (o) => (o ? o[state.lang] ?? o.en : "");

// ---------- tiny helpers ----------
const $app = document.getElementById("app");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function toast(msg, err = false) {
  const el = document.getElementById("toast");
  el.textContent = msg; el.className = "toast" + (err ? " err" : ""); el.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (el.hidden = true), 3500);
}
const fmtDate = (d) => new Date(d).toLocaleString(state.lang === "zh" ? "zh-TW" : "en-GB", {
  weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Taipei",
});
const yearLabel = (year) => state.lang === "zh"
  ? ({ "1": "大一", "2": "大二", "3": "大三", "4": "大四", "5+": "大五以上", Master: "碩士班", PhD: "博士班" }[year] || year)
  : year;
function countdown(to) {
  const ms = new Date(to) - Date.now();
  if (ms <= 0) return "0:00";
  const d = Math.floor(ms / 864e5), h = Math.floor(ms / 36e5) % 24, m = Math.floor(ms / 6e4) % 60;
  if (state.lang === "zh") return (d ? `${d} 天 ` : "") + `${h} 小時 ${m} 分鐘`;
  return (d ? `${d}d ` : "") + `${h}h ${m}m`;
}
function go(hash) { if (location.hash !== hash) location.hash = hash; else render(); }

// ---------- photos (private bucket, signed URLs) ----------
const urlCache = new Map();
async function photoUrls(paths) {
  const need = [...new Set(paths.filter((x) => x && !urlCache.has(x)))];
  if (need.length) {
    const { data } = await sb.storage.from("avatars").createSignedUrls(need, 60 * 60 * 6);
    (data || []).forEach((d) => { if (d.signedUrl) urlCache.set(d.path, d.signedUrl); });
  }
  return (x) => urlCache.get(x) || "";
}
const FALLBACK_PIC = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#3a2441"/><text x="50" y="62" font-size="40" text-anchor="middle">🙂</text></svg>');
// Shrink to max 1080px and re-encode as JPEG before upload
function resizeImage(file, max = 1080) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      c.toBlob((b) => (b ? resolve(b) : reject(new Error("resize failed"))), "image/jpeg", 0.85);
      URL.revokeObjectURL(img.src);
    };
    img.onerror = () => reject(new Error("bad image"));
    img.src = URL.createObjectURL(file);
  });
}
async function uploadPhoto(file) {
  const blob = await resizeImage(file);
  const path = `${state.profile.id}/${Date.now()}.jpg`;
  const { error } = await sb.storage.from("avatars").upload(path, blob, { contentType: "image/jpeg", upsert: false });
  if (error) throw error;
  const old = state.profile.photo_path;
  const { error: e2 } = await sb.from("profiles").update({ photo_path: path }).eq("id", state.profile.id);
  if (e2) throw e2;
  if (old) sb.storage.from("avatars").remove([old]).then(() => {});
  state.profile.photo_path = path;
  return path;
}

// ---------- data ----------
async function loadMe() {
  const { data: { session } } = await sb.auth.getSession();
  state.session = session;
  if (!session) { state.profile = null; state.quiz = null; return; }
  const [{ data: p }, { data: q }] = await Promise.all([
    sb.from("profiles").select("*").eq("id", session.user.id).maybeSingle(),
    sb.from("quiz_answers").select("*").eq("user_id", session.user.id).maybeSingle(),
  ]);
  state.profile = p; state.quiz = q;
  if (p?.lang && !localStorage.getItem("ud_lang")) state.lang = p.lang;
}

// ---------- nav ----------
function renderNav(route) {
  const nav = document.getElementById("nav");
  const link = (h, k) => `<a href="${h}" class="${route === h ? "active" : ""}">${t(k)}</a>`;
  let html = "";
  if (state.session) {
    html += link("#/swipe", "nav_swipe") + link("#/home", "nav_supper") + link("#/matches", "nav_matches") + link("#/profile", "nav_profile");
    if (state.profile?.is_admin) html += link("#/admin", "nav_admin");
  } else {
    html += `<a href="#/login" class="btn small orange" style="color:#fff">${t("nav_login")}</a>`;
  }
  html += `<button class="lang" id="langBtn">${state.lang === "en" ? "中文" : "EN"}</button>`;
  nav.innerHTML = html;
  nav.classList.toggle("tabs", !!state.session);
  document.body.classList.toggle("has-tabs", !!state.session);
  document.getElementById("langBtn").onclick = () => setLang(state.lang === "en" ? "zh" : "en");
}

// ---------- router ----------
let timers = [];
async function render() {
  timers.forEach(clearInterval); timers = [];
  const hash = location.hash || "#/";
  const [, page, arg] = hash.split("/");
  const route = "#/" + (page || "");
  renderNav(route);

  const needAuth = ["swipe", "home", "supper", "matches", "profile", "admin", "onboarding"].includes(page);
  const ready = state.profile?.onboarded && state.profile?.photo_path;
  if (needAuth && !state.session) return go("#/login");
  if (state.session && page !== "onboarding" && needAuth && !ready) return go("#/onboarding");
  if ((page === "" || page === undefined || page === "login") && state.session) return go(ready ? "#/swipe" : "#/onboarding");

  window.scrollTo(0, 0);
  if (page === "privacy") return renderPrivacy();
  if (state.session && state.profile && !state.profile.consented_at) return renderConsent();
  try {
    switch (page) {
      case "login": return renderLogin();
      case "onboarding": return renderOnboarding(state.profile?.onboarded && !state.profile?.photo_path ? 1 : 0);
      case "swipe": return await renderSwipe();
      case "home": return await renderHome();
      case "supper": return await renderSupper(arg);
      case "matches": return await renderMatches();
      case "profile": return await renderProfile();
      case "admin": return await renderAdmin();
      default: return renderLanding();
    }
  } catch (e) {
    console.error(e);
    $app.innerHTML = `<div class="card center"><p>${t("err_generic")}</p><p class="small muted">${esc(e.message)}</p></div>`;
  }
}

// ---------- privacy & consent ----------
function renderPrivacy() {
  $app.innerHTML = `<div class="card prose" style="max-width:720px;margin:0 auto">${PRIVACY[state.lang] || PRIVACY.en}
    <p style="margin-top:24px"><a class="btn ghost small" href="#/">← UniDate</a></p></div>`;
}
function renderConsent() {
  $app.innerHTML = `<div class="card" style="max-width:520px;margin:30px auto">
    <h2>${t("cs_title")}</h2>
    <p class="muted">${t("cs_sub")}</p>
    <label class="consent"><input type="checkbox" id="consent" /> <span>${t("cs_label")}</span></label>
    <div class="row" style="margin-top:18px;justify-content:space-between">
      <button class="btn ghost small" id="out">${t("nav_logout")}</button>
      <button class="btn orange" id="ok">${t("cs_accept")}</button>
    </div></div>`;
  document.getElementById("ok").onclick = async () => {
    if (!document.getElementById("consent").checked) return toast(t("cs_need"), true);
    const { error } = await sb.rpc("give_consent");
    if (error) return toast(error.message, true);
    state.profile.consented_at = new Date().toISOString();
    render();
  };
  document.getElementById("out").onclick = async () => { await sb.auth.signOut(); state.session = null; state.profile = null; go("#/"); };
}

// ---------- landing ----------
function renderLanding() {
  const steps = [1, 2, 3, 4, 5].map((i) => `
    <div class="step"><div class="num">${i}</div><div><h3>${t(`s${i}_t`)}</h3><p>${t(`s${i}_d`)}</p></div></div>`).join("");
  const why = [1, 2, 3, 4].map((i) => `<div class="card"><h3>${t(`w${i}_t`)}</h3><p class="muted">${t(`w${i}_d`)}</p></div>`).join("");
  const faq = [1, 2, 3, 4].map((i) => `<details><summary>${t(`f${i}_q`)}</summary><p>${t(`f${i}_a`)}</p></details>`).join("");
  $app.innerHTML = `
    <div class="hero">
      <span class="pill lav small">${t("hero_kicker")}</span>
      <h1 style="margin-top:16px">${t("hero_title_a")} <span class="strike">${t("hero_title_strike")}</span><br/>${t("hero_title_b")}</h1>
      <p class="zh">${t("hero_sub")}</p>
      <div class="row" style="margin-top:22px">
        <a class="btn orange" href="#/login">${t("hero_cta")} →</a>
      </div>
      <p class="small muted" style="margin-top:10px">${t("hero_note")}</p>
    </div>
    <div class="road" aria-hidden="true">
      <div class="side"><span>🐼</span>NTHU</div>
      <div class="street"><b>${t("road_label")}</b></div>
      <div class="side"><span>🦊</span>NYCU</div>
    </div>
    <section><h2>${t("how_title")}</h2><div class="steps">${steps}</div></section>
    <section><h2>${t("why_title")}</h2><div class="grid">${why}</div></section>
    <section class="faq"><h2>${t("faq_title")}</h2>${faq}</section>
    <section class="card green center">
      <h2 style="color:#fff">${t("hero_title_b")}</h2>
      <a class="btn" style="background:var(--cream);color:var(--ink)" href="#/login">${t("hero_cta")}</a>
    </section>`;
}

// ---------- login ----------
function renderLogin(signup = false) {
  $app.innerHTML = `
    <div class="card" style="max-width:480px;margin:40px auto">
      <h2>${signup ? t("login_signup_title") : t("login_title")}</h2>
      <p class="muted">${t("login_sub")}</p>
      <form id="f">
        <label for="email">${t("login_email")}</label>
        <input id="email" type="email" required placeholder="s112xxxxx@gapp.nthu.edu.tw" autocomplete="email" />
        <label for="pw">${t("login_password")}</label>
        <input id="pw" type="password" required minlength="8" autocomplete="${signup ? "new-password" : "current-password"}" />
        ${signup ? `<p class="small muted" style="margin-top:6px">${t("login_pw_hint")}</p>
        <label class="consent"><input type="checkbox" id="consent" /> <span>${t("cs_label")}</span></label>` : ""}
        <button class="btn orange" style="margin-top:16px;width:100%" id="send">${signup ? t("login_signup") : t("login_send")}</button>
      </form>
      <p class="center" style="margin-top:16px"><a href="#" id="swap">${signup ? t("login_to_signin") : t("login_to_signup")}</a></p>
      ${signup ? "" : `<p class="small muted center">${t("login_forgot")}</p>`}
    </div>`;
  document.getElementById("swap").onclick = (e) => { e.preventDefault(); renderLogin(!signup); };
  document.getElementById("f").onsubmit = async (e) => {
    e.preventDefault();
    const email = document.getElementById("email").value.trim().toLowerCase();
    const password = document.getElementById("pw").value;
    if (!SCHOOL_RE.test(email)) return toast(t("login_bad_domain"), true);
    if (password.length < 8) return toast(t("login_pw_hint"), true);
    if (signup && !document.getElementById("consent").checked) return toast(t("cs_need"), true);
    const btn = document.getElementById("send"); btn.disabled = true;
    let res;
    if (signup) {
      res = await sb.auth.signUp({ email, password, options: { data: { consent: "true" } } });
      // Supabase returns a user with no identities when the email is already registered
      if (!res.error && res.data?.user && (res.data.user.identities || []).length === 0) {
        btn.disabled = false; return toast(t("login_exists"), true);
      }
    } else {
      res = await sb.auth.signInWithPassword({ email, password });
    }
    btn.disabled = false;
    if (res.error) {
      const m = res.error.message || "";
      if (/18\+|privacy/i.test(m)) return toast(t("cs_need"), true);
      if (/school|NTHU|NYCU/i.test(m)) return toast(t("login_bad_domain"), true);
      if (/invalid login/i.test(m)) return toast(t("login_wrong"), true);
      if (/already registered/i.test(m)) return toast(t("login_exists"), true);
      if (/not confirmed/i.test(m)) return toast(t("login_not_confirmed"), true);
      return toast(m, true);
    }
    if (!res.data?.session) {
      // Sign-up with email confirmation on: no session until they click the link
      $app.innerHTML = `<div class="card center" style="max-width:480px;margin:40px auto">
        <p style="font-size:2.4rem;margin:0">✉️</p><h2>${esc(email)}</h2><p>${t("login_check_email")}</p>
        <a class="btn ghost" href="#/login" id="backlogin">${t("login_title")}</a></div>`;
      document.getElementById("backlogin").onclick = (ev) => { ev.preventDefault(); renderLogin(false); };
      return;
    }
    await loadMe();
    go(state.profile?.onboarded && state.profile?.photo_path ? "#/swipe" : "#/onboarding");
  };
}

// ---------- onboarding (profile + quiz) ----------
const PROFILE_FIELDS = [
  { id: "gender", key: "ob_gender", opts: [["man", "Man", "男生"], ["woman", "Woman", "女生"], ["nonbinary", "Non-binary", "非二元性別"], ["na", "Prefer not to say", "暫不透露"]] },
  { id: "interested_in", key: "ob_interest", opts: [["men", "Men", "男生"], ["women", "Women", "女生"], ["everyone", "Everyone", "都可以"]] },
  { id: "mode", key: "ob_mode", opts: [["dating", "mode_dating"], ["friends", "mode_friends"], ["both", "mode_both"]] },
];
function choiceRow(field, current) {
  return `<div class="choices" data-field="${field.id}">` + field.opts.map((o) => {
    const label = o.length === 2 ? t(o[1]) : (state.lang === "zh" ? o[2] : o[1]);
    return `<button type="button" class="choice ${current === o[0] ? "on" : ""}" data-v="${o[0]}">${label}</button>`;
  }).join("") + `</div>`;
}
function wireChoices(root, obj) {
  root.querySelectorAll(".choices").forEach((row) => {
    row.querySelectorAll(".choice").forEach((b) => (b.onclick = () => {
      row.querySelectorAll(".choice").forEach((x) => x.classList.remove("on"));
      b.classList.add("on");
      obj[row.dataset.field] = b.dataset.v;
    }));
  });
}
function profileFormHtml(p) {
  return `
    <label>${t("ob_name")}</label><input id="display_name" maxlength="30" required value="${esc(p.display_name || "")}" />
    <label>${t("ob_dept")}</label><input id="department" maxlength="60" placeholder="${esc(t("ob_dept_ph"))}" value="${esc(p.department || "")}" />
    <label>${t("ob_bio")}</label><textarea id="bio" maxlength="160" placeholder="${esc(t("ob_bio_ph"))}">${esc(p.bio || "")}</textarea>
    <label>${t("ob_year")}</label>
    <select id="year">${["", "1", "2", "3", "4", "5+", "Master", "PhD"].map((y) => `<option ${p.year === y ? "selected" : ""} value="${y}">${yearLabel(y) || "—"}</option>`).join("")}</select>
    ${PROFILE_FIELDS.map((f) => `<label>${t(f.key)}</label>${choiceRow(f, p[f.id])}`).join("")}`;
}
function readProfileForm(obj) {
  return {
    display_name: document.getElementById("display_name").value.trim(),
    department: document.getElementById("department").value.trim(),
    bio: document.getElementById("bio").value.trim() || null,
    year: document.getElementById("year").value,
    gender: obj.gender || null, interested_in: obj.interested_in || null, mode: obj.mode || "both",
  };
}

function photoPickerHtml(url) {
  return `<div class="photo-pick">
      <div class="ph" id="phbox">${url ? `<img src="${esc(url)}" alt="" />` : "📷"}</div>
      <label class="btn ghost small" style="margin:0;cursor:pointer">${url ? t("ph_change") : t("ph_pick")}
        <input type="file" id="phfile" accept="image/jpeg,image/png,image/webp" hidden /></label>
    </div>`;
}
function wirePhotoPicker(onDone) {
  document.getElementById("phfile").onchange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return toast(t("ph_bad"), true);
    const box = document.getElementById("phbox");
    box.innerHTML = `<span class="small">${t("ph_uploading")}</span>`;
    try {
      const path = await uploadPhoto(file);
      const url = (await photoUrls([path]))(path);
      box.innerHTML = `<img src="${esc(url)}" alt="" />`;
      onDone && onDone(path);
    } catch (err) {
      console.error(err); box.textContent = "📷"; toast(t("err_generic"), true);
    }
  };
}

function renderOnboarding(startStep = 0) {
  const p = state.profile || {};
  const answers = { ...(state.quiz?.answers || {}) };
  const choices = { gender: p.gender, interested_in: p.interested_in, mode: p.mode };
  let step = startStep; // 0 = profile, 1 = photo, 2..QUIZ.length+1 = quiz
  const total = QUIZ.length + 2;

  const finish = async () => {
    if (!state.profile.onboarded) {
      await sb.from("profiles").update({ onboarded: true }).eq("id", p.id);
      state.profile.onboarded = true;
    }
    toast(t("saved")); go("#/swipe");
  };

  const draw = async () => {
    const pct = Math.round((step / total) * 100);
    if (step === 0) {
      $app.innerHTML = `<div class="card" style="max-width:560px;margin:20px auto">
        <div class="progress"><div style="width:${pct}%"></div></div>
        <h2>${t("ob_title")}</h2>
        <p class="small muted"><span class="tag ${esc(p.school)}">${esc(p.school)}</span> ${esc(p.email)}</p>
        <form id="pf">${profileFormHtml(p)}
          <button class="btn orange" style="margin-top:20px;width:100%">${t("ob_next")} →</button>
        </form></div>`;
      wireChoices($app, choices);
      document.getElementById("pf").onsubmit = async (e) => {
        e.preventDefault();
        const vals = readProfileForm(choices);
        if (!vals.display_name) return;
        const { error } = await sb.from("profiles").update(vals).eq("id", p.id);
        if (error) return toast(error.message, true);
        Object.assign(state.profile, vals);
        step = 1; draw();
      };
    } else if (step === 1) {
      const url = p.photo_path ? (await photoUrls([p.photo_path]))(p.photo_path) : "";
      $app.innerHTML = `<div class="card" style="max-width:560px;margin:20px auto">
        <div class="progress"><div style="width:${pct}%"></div></div>
        <h2>${t("ph_title")}</h2>
        <p class="muted">${t("ph_sub")}</p>
        ${photoPickerHtml(url)}
        <div class="row" style="justify-content:space-between">
          <button class="btn ghost small" id="back">← ${t("ob_back")}</button>
          <button class="btn orange" id="next">${t("ob_next")} →</button>
        </div></div>`;
      wirePhotoPicker(() => {});
      document.getElementById("back").onclick = () => { step = 0; draw(); };
      document.getElementById("next").onclick = () => {
        if (!state.profile.photo_path) return toast(t("ph_required"), true);
        if (state.profile.onboarded) return finish(); // only the photo was missing
        step = 2; draw();
      };
    } else {
      const qd = QUIZ[step - 2];
      $app.innerHTML = `<div class="card" style="max-width:560px;margin:20px auto">
        <div class="progress"><div style="width:${pct}%"></div></div>
        <p class="small muted">${t("ob_quiz")} · ${step - 1}/${QUIZ.length}</p>
        <h2>${tt(qd.q)}</h2>
        <div class="choices" style="flex-direction:column;align-items:stretch">
          ${qd.a.map((a) => `<button type="button" class="choice ${answers[qd.id] === a.v ? "on" : ""}" data-v="${a.v}" style="text-align:left;border-radius:14px;padding:14px 16px">${tt(a)}</button>`).join("")}
        </div>
        <div class="row" style="margin-top:18px;justify-content:space-between">
          <button class="btn ghost small" id="back">← ${t("ob_back")}</button>
        </div></div>`;
      $app.querySelectorAll(".choice").forEach((b) => (b.onclick = async () => {
        answers[qd.id] = b.dataset.v;
        if (step < QUIZ.length + 1) { step++; draw(); return; }
        const { error } = await sb.from("quiz_answers").upsert({ user_id: p.id, answers, updated_at: new Date().toISOString() });
        if (error) return toast(error.message, true);
        state.quiz = { answers };
        finish();
      }));
      document.getElementById("back").onclick = () => { step--; draw(); };
    }
  };
  draw();
}

// ---------- swipe ----------
function vibeChips(answers) {
  if (!answers) return [];
  return ["energy", "food", "night", "looking"].map((id) => {
    const q = QUIZ.find((x) => x.id === id);
    const a = q && q.a.find((x) => x.v === answers[id]);
    return a ? tt(a) : null;
  }).filter(Boolean);
}

async function renderSwipe() {
  $app.innerHTML = `<div class="loading">…</div>`;
  const { data, error } = await sb.rpc("swipe_deck", { p_limit: 30 });
  if (error) throw error;
  const deck = data || [];
  const url = await photoUrls(deck.map((d) => d.photo_path));
  let i = 0;

  $app.innerHTML = `<div class="deck-wrap">
      <div class="deck" id="deck"></div>
      <div class="swipe-btns">
        <button class="round nope" id="nopeBtn" aria-label="${esc(t("sw_nope"))}">✕</button>
        <button class="round like" id="likeBtn" aria-label="${esc(t("sw_like"))}">♥</button>
      </div>
      <p class="center small muted">${t("sw_hint")}</p>
    </div>`;
  const $deck = document.getElementById("deck");

  const cardHtml = (d, under) => `<div class="swipe-card ${under ? "under" : ""}" data-id="${d.id}">
      <img src="${esc(url(d.photo_path) || FALLBACK_PIC)}" alt="" />
      <div class="stamp like">${state.lang === "zh" ? t("sw_like") : "LIKE"}</div><div class="stamp nope">${state.lang === "zh" ? t("sw_nope") : "NOPE"}</div>
      <div class="info">
        <h2>${esc(d.display_name || "—")}</h2>
        <div><span class="tag ${d.school}">${d.school} ${d.school === "NTHU" ? "🐼" : "🦊"}</span>
          <span class="small"> ${esc(d.department || "")}${d.year ? " · " + esc(yearLabel(d.year)) : ""}</span></div>
        ${d.bio ? `<p>${esc(d.bio)}</p>` : ""}
        <div class="chips">${vibeChips(d.vibe).map((c) => `<span class="chip">${esc(c)}</span>`).join("")}</div>
      </div></div>`;

  const draw = () => {
    if (i >= deck.length) {
      $deck.innerHTML = `<div class="empty-deck"><div><p style="font-size:2.4rem;margin:0">🐼🌙🦊</p><p>${t("sw_empty")}</p>
        <a class="btn orange small" href="#/home">${t("nav_supper")}</a></div></div>`;
      document.getElementById("likeBtn").disabled = true; document.getElementById("nopeBtn").disabled = true;
      return;
    }
    $deck.innerHTML = (deck[i + 1] ? cardHtml(deck[i + 1], true) : "") + cardHtml(deck[i], false);
    wireDrag($deck.querySelector(".swipe-card:not(.under)"));
  };

  let busy = false;
  const decide = async (liked) => {
    if (busy || i >= deck.length) return;
    busy = true;
    const d = deck[i];
    const card = $deck.querySelector(".swipe-card:not(.under)");
    if (card) {
      card.style.transform = `translate(${liked ? 600 : -600}px, -40px) rotate(${liked ? 25 : -25}deg)`;
      card.style.opacity = "0";
    }
    const req = sb.rpc("swipe", { p_to: d.id, p_liked: liked });
    await new Promise((r) => setTimeout(r, 260));
    i++; draw(); busy = false;
    const { data: matched, error } = await req;
    if (error) return toast(error.message, true);
    if (matched) showMatch(d, url(d.photo_path));
  };

  function wireDrag(card) {
    if (!card) return;
    let sx = 0, sy = 0, dx = 0, dy = 0, down = false;
    const like = card.querySelector(".stamp.like"), nope = card.querySelector(".stamp.nope");
    card.onpointerdown = (e) => { down = true; sx = e.clientX; sy = e.clientY; card.setPointerCapture(e.pointerId); card.classList.add("dragging"); };
    card.onpointermove = (e) => {
      if (!down) return;
      dx = e.clientX - sx; dy = e.clientY - sy;
      card.style.transform = `translate(${dx}px, ${dy * 0.3}px) rotate(${dx / 18}deg)`;
      like.style.opacity = Math.max(0, Math.min(1, dx / 100));
      nope.style.opacity = Math.max(0, Math.min(1, -dx / 100));
    };
    const end = () => {
      if (!down) return; down = false; card.classList.remove("dragging");
      if (Math.abs(dx) > 110) decide(dx > 0);
      else { card.style.transform = ""; like.style.opacity = 0; nope.style.opacity = 0; }
      dx = dy = 0;
    };
    card.onpointerup = end; card.onpointercancel = end;
  }

  document.getElementById("likeBtn").onclick = () => decide(true);
  document.getElementById("nopeBtn").onclick = () => decide(false);
  draw();
}

function showMatch(d, theirUrl) {
  const mine = urlCache.get(state.profile.photo_path) || FALLBACK_PIC;
  const ov = document.createElement("div");
  ov.className = "overlay";
  ov.innerHTML = `<div class="match-box">
      <h1>${t("sw_match")}</h1>
      <div class="match-pics"><img src="${esc(mine)}" alt="" /><img src="${esc(theirUrl || FALLBACK_PIC)}" alt="" /></div>
      <p>${t("sw_match_sub")}</p>
      <div class="row" style="justify-content:center;margin-top:16px">
        <a class="btn orange" href="#/matches" id="mGo">${t("m_say_hi")} 💬</a>
        <button class="btn ghost" id="mKeep" style="color:var(--ink);border-color:var(--ink)">${t("sw_keep")}</button>
      </div></div>`;
  document.body.appendChild(ov);
  const close = () => ov.remove();
  document.getElementById("mKeep").onclick = close;
  document.getElementById("mGo").onclick = close;
}

// ---------- home: supper nights ----------
async function renderHome() {
  $app.innerHTML = `<div class="loading">…</div>`;
  const nowIso = new Date(Date.now() - 6 * 36e5).toISOString();
  const [{ data: nights, error }, { data: myBookings }] = await Promise.all([
    sb.from("supper_nights").select("*").gte("starts_at", nowIso).order("starts_at"),
    sb.from("bookings").select("*").eq("user_id", state.profile.id),
  ]);
  if (error) throw error;
  const booked = Object.fromEntries((myBookings || []).filter((b) => b.status === "booked").map((b) => [b.night_id, b]));

  const cards = (nights || []).map((n) => {
    const b = booked[n.id];
    const open = n.status === "open" && new Date(n.booking_closes_at) > new Date();
    let action;
    if (b) action = `<span class="pill green">${t("home_booked")} · ${esc(b.budget)}</span>
        <a class="btn small" href="#/supper/${n.id}">${t("home_view")} →</a>
        ${open ? `<button class="btn ghost small" data-cancel="${b.id}">${t("home_cancel")}</button>` : ""}`;
    else if (open) action = `<button class="btn orange small" data-book="${n.id}">${t("home_book")}</button>`;
    else action = `<span class="pill line">${state.lang === "zh" ? "已截止" : "Closed"}</span>`;
    return `<div class="card">
      <div class="night">
        <div><div class="date">${fmtDate(n.starts_at)}</div>
          <div class="small muted">${t("home_closes")}: ${fmtDate(n.booking_closes_at)}</div></div>
        <div class="row">${action}</div>
      </div>
      <div id="bk-${n.id}"></div>
    </div>`;
  }).join("");

  $app.innerHTML = `
    <h1 style="font-size:2.2rem">${t("home_hi")}, ${esc(state.profile.display_name || "")} ${state.profile.school === "NTHU" ? "🐼" : "🦊"}</h1>
    <h2 style="font-size:1.4rem;margin-top:24px">${t("home_upcoming")}</h2>
    ${cards || `<div class="card center muted">${t("home_none")}</div>`}
    <div class="card lav small">${t("sup_safety")}</div>`;

  $app.querySelectorAll("[data-book]").forEach((btn) => (btn.onclick = () => {
    const id = btn.dataset.book; const box = document.getElementById("bk-" + id);
    const sel = { budget: "$$" };
    box.innerHTML = `<div class="reveal-box open">
      <label>${t("home_budget")}</label>
      <div class="choices" data-field="budget">${["$", "$$", "$$$"].map((v) => `<button type="button" class="choice ${v === "$$" ? "on" : ""}" data-v="${v}">${v}</button>`).join("")}</div>
      <label>${t("home_diet")}</label><input id="diet-${id}" maxlength="80" placeholder="${esc(t("home_diet_ph"))}" />
      <button class="btn orange" style="margin-top:14px" id="conf-${id}">${t("home_confirm")}</button></div>`;
    wireChoices(box, sel);
    document.getElementById("conf-" + id).onclick = async () => {
      const diet = document.getElementById("diet-" + id).value.trim() || null;
      const existing = (myBookings || []).find((b) => b.night_id === id);
      const q = existing
        ? sb.from("bookings").update({ status: "booked", budget: sel.budget, diet }).eq("id", existing.id)
        : sb.from("bookings").insert({ night_id: id, user_id: state.profile.id, budget: sel.budget, diet });
      const { error } = await q;
      if (error) return toast(error.message, true);
      toast("🎉 " + t("home_booked")); renderHome();
    };
  }));
  $app.querySelectorAll("[data-cancel]").forEach((btn) => (btn.onclick = async () => {
    const { error } = await sb.from("bookings").update({ status: "cancelled" }).eq("id", btn.dataset.cancel);
    if (error) return toast(error.message, true);
    renderHome();
  }));
}

// ---------- supper detail (reveals, icebreaker, see again) ----------
async function renderSupper(nightId) {
  $app.innerHTML = `<div class="loading">…</div>`;
  const { data: s, error } = await sb.rpc("my_supper", { p_night: nightId });
  if (error) throw error;
  if (!s) return go("#/home");

  const now = Date.now();
  const lockBox = (title, at, inner) => {
    const isOpen = at && new Date(at) <= now;
    return `<div class="reveal-box ${isOpen ? "open" : ""}"><h4>${title}</h4>${
      isOpen ? inner : `<span class="muted">🔒 ${t("sup_locked")} <span class="countdown" data-to="${at || ""}">${at ? countdown(at) : "—"}</span></span>`}</div>`;
  };

  let html = `<a href="#/home" class="small">← ${t("nav_supper")}</a>
    <h1 style="font-size:2.2rem;margin-top:10px">${fmtDate(s.starts_at)}</h1>`;

  if (!s.has_group) {
    html += `<div class="card center"><p style="font-size:2rem">🐼🍜🦊</p><p>${t("sup_waiting_group")}</p></div>`;
    $app.innerHTML = html; return;
  }

  const stats = s.stats;
  const statsHtml = stats ? `<p><span class="pill">${stats.size} ${t("sup_people")}</span></p>
      <div class="row">${Object.entries(stats.schools || {}).map(([k, v]) => `<span class="pill ${k === "NTHU" ? "lav" : "green"}">${v} × ${k} ${k === "NTHU" ? "🐼" : "🦊"}</span>`).join("")}</div>
      <div class="row" style="margin-top:8px">${Object.entries(stats.departments || {}).map(([k, v]) => `<span class="pill soft">${v} × ${esc(k)}</span>`).join("")}</div>` : "";
  const whereHtml = s.restaurant_name ? `<p><b>${esc(s.restaurant_name)}</b><br/><span class="muted">${esc(s.restaurant_address || "")}</span></p>
      ${s.restaurant_address ? `<a class="btn small" target="_blank" rel="noopener" href="https://maps.google.com/?q=${encodeURIComponent(s.restaurant_name + " " + s.restaurant_address)}">📍 ${t("sup_maps")}</a>` : ""}` : `<p class="muted">—</p>`;
  const afterHtml = s.after_spot_name ? `<p><b>${esc(s.after_spot_name)}</b><br/><span class="muted">${esc(s.after_spot_address || "")}</span></p>` : "";

  html += `<div class="card">
      ${lockBox("1 · " + t("sup_table"), s.stats_reveal_at, statsHtml)}
      ${lockBox("2 · " + t("sup_where"), s.location_reveal_at, whereHtml)}
      ${s.after_spot_reveal_at ? lockBox("3 · " + t("sup_after"), s.after_spot_reveal_at, afterHtml) : ""}
    </div>
    <div class="card lav small">${t("sup_safety")}</div>`;

  const started = new Date(s.starts_at) <= now;
  if (started) {
    html += `<div class="icebreaker" style="margin-bottom:16px">
        <span class="pill pink">${t("sup_icebreak")}</span>
        <div class="q" id="ibq"></div><div class="qzh" id="ibz"></div>
        <button class="btn" id="ibn">${t("sup_next_q")} 🎲</button></div>`;

    const { data: picks } = await sb.from("see_again").select("to_user").eq("night_id", nightId);
    const picked = new Set((picks || []).map((p) => p.to_user));
    const purl = await photoUrls((s.members || []).map((m) => m.photo_path));
    const members = (s.members || []).map((m) => `<div class="member">
        <div class="who-row"><img class="avatar" src="${esc(purl(m.photo_path) || FALLBACK_PIC)}" alt="" />
          <div class="who"><b>${esc(m.display_name || "—")}</b><span class="small muted"><span class="tag ${m.school}">${m.school}</span> ${esc(m.department || "")}</span></div></div>
        <div class="row">
          <button class="btn small ${picked.has(m.id) ? "" : "orange"}" data-pick="${m.id}">${picked.has(m.id) ? t("sup_picked") : t("sup_pick")}</button>
          <button class="btn ghost small" data-block="${m.id}">${t("sup_block")}</button>
          <button class="btn ghost small" data-report="${m.id}">${t("sup_report")}</button>
        </div></div>`).join("");
    html += `<div class="card"><h3>${t("sup_see_again")}</h3><p class="small muted">${t("sup_see_again_sub")}</p>${members}</div>`;
    $app.innerHTML = html;

    let qi = Math.floor(Math.random() * ICEBREAKERS.length);
    const showQ = () => {
      const q = ICEBREAKERS[qi % ICEBREAKERS.length];
      document.getElementById("ibq").textContent = state.lang === "zh" ? q.zh : q.en;
      document.getElementById("ibz").textContent = state.lang === "zh" ? q.en : q.zh;
    };
    showQ(); document.getElementById("ibn").onclick = () => { qi++; showQ(); };

    $app.querySelectorAll("[data-pick]").forEach((b) => (b.onclick = async () => {
      const uid = b.dataset.pick;
      const q = picked.has(uid)
        ? sb.from("see_again").delete().match({ night_id: nightId, from_user: state.profile.id, to_user: uid })
        : sb.from("see_again").insert({ night_id: nightId, from_user: state.profile.id, to_user: uid });
      const { error } = await q;
      if (error) return toast(error.message, true);
      renderSupper(nightId);
    }));
    $app.querySelectorAll("[data-block]").forEach((b) => (b.onclick = async () => {
      if (!confirm(t("sup_block") + "?")) return;
      const { error } = await sb.from("blocks").insert({ blocker: state.profile.id, blocked: b.dataset.block });
      if (error && !/duplicate/i.test(error.message)) return toast(error.message, true);
      toast(t("sup_blocked")); renderSupper(nightId);
    }));
    $app.querySelectorAll("[data-report]").forEach((b) => (b.onclick = async () => {
      const reason = prompt(t("sup_report_reason"));
      if (!reason) return;
      const { error } = await sb.from("reports").insert({ reporter: state.profile.id, reported: b.dataset.report, reason });
      if (error) return toast(error.message, true);
      toast(t("sup_reported"));
    }));
  } else {
    $app.innerHTML = html;
  }

  timers.push(setInterval(() => {
    let reload = false;
    $app.querySelectorAll(".countdown[data-to]").forEach((el) => {
      if (!el.dataset.to) return;
      if (new Date(el.dataset.to) <= Date.now()) reload = true;
      el.textContent = countdown(el.dataset.to);
    });
    if (reload) renderSupper(nightId);
  }, 30000));
}

// ---------- matches ----------
async function renderMatches() {
  $app.innerHTML = `<div class="loading">…</div>`;
  const { data: matches, error } = await sb.rpc("my_matches");
  if (error) throw error;
  const url = await photoUrls((matches || []).map((m) => m.photo_path));

  const mHtml = (matches || []).map((m) => `<div class="card match">
      <div class="who-row"><img class="avatar" src="${esc(url(m.photo_path) || FALLBACK_PIC)}" alt="" />
        <div><span class="pill ${m.source === "swipe" ? "" : "gold"} small">${m.source === "swipe" ? t("m_from_swipe") : t("m_from_supper")}</span>
        <h3 style="margin:8px 0 2px">${esc(m.display_name || "—")}</h3>
        <span class="small muted"><span class="tag ${m.school}">${m.school}</span> ${esc(m.department || "")}</span></div></div>
      <a class="btn orange small" href="mailto:${esc(m.email)}?subject=${encodeURIComponent("Hi from UniDate 🐼🦊")}">${t("m_say_hi")} ✉️</a>
    </div>`).join("");

  $app.innerHTML = `
    <h1 style="font-size:2.2rem">${t("m_title")}</h1>
    <p class="muted">${t("sup_see_again_sub")}</p>
    ${mHtml || `<div class="card center muted">${t("m_none")}</div>`}`;
}

// ---------- profile ----------
async function renderProfile() {
  const p = state.profile; const choices = { gender: p.gender, interested_in: p.interested_in, mode: p.mode };
  const url = p.photo_path ? (await photoUrls([p.photo_path]))(p.photo_path) : "";
  $app.innerHTML = `<div class="card" style="max-width:560px;margin:0 auto">
    <h2>${t("p_title")}</h2>
    <p class="small muted"><span class="tag ${p.school}">${p.school}</span> ${esc(p.email)}</p>
    ${photoPickerHtml(url)}
    <p class="small muted center">${t("ph_sub")}</p>
    <form id="pf">${profileFormHtml(p)}
      <div class="row" style="margin-top:20px">
        <button class="btn orange">${t("p_save")}</button>
        <button type="button" class="btn ghost" id="retake">${t("p_retake")}</button>
        <button type="button" class="btn ghost" id="logout">${t("nav_logout")}</button>
      </div></form>
    <hr style="border:0;border-top:1px solid var(--line);margin:28px 0 18px" />
    <div class="row" style="justify-content:space-between">
      <a class="small" href="#/privacy">${t("pv_link")}</a>
      <button type="button" class="btn danger small" id="delacct">${t("del_btn")}</button>
    </div></div>`;
  wireChoices($app, choices);
  wirePhotoPicker(() => toast(t("saved")));
  document.getElementById("pf").onsubmit = async (e) => {
    e.preventDefault();
    const vals = readProfileForm(choices);
    const { error } = await sb.from("profiles").update(vals).eq("id", p.id);
    if (error) return toast(error.message, true);
    Object.assign(state.profile, vals); toast(t("saved"));
  };
  document.getElementById("retake").onclick = () => { location.hash = "#/onboarding"; };
  document.getElementById("logout").onclick = async () => { await sb.auth.signOut(); state.session = null; state.profile = null; go("#/"); };
  document.getElementById("delacct").onclick = async () => {
    if (!confirm(t("del_confirm"))) return;
    const btn = document.getElementById("delacct"); btn.disabled = true;
    // remove every photo in the user's folder, then the account itself
    const { data: files } = await sb.storage.from("avatars").list(p.id);
    if (files?.length) await sb.storage.from("avatars").remove(files.map((f) => `${p.id}/${f.name}`));
    const { error } = await sb.rpc("delete_my_account");
    if (error) { btn.disabled = false; return toast(error.message, true); }
    await sb.auth.signOut().catch(() => {});
    state.session = null; state.profile = null; urlCache.clear();
    toast(t("del_done")); go("#/");
  };
}

// ---------- admin ----------
async function renderAdmin() {
  if (!state.profile.is_admin) return go("#/home");
  $app.innerHTML = `<div class="loading">…</div>`;
  const [{ data: nights }, { data: reports }] = await Promise.all([
    sb.from("supper_nights").select("*").order("starts_at", { ascending: false }).limit(20),
    sb.from("reports").select("*").order("created_at", { ascending: false }).limit(50),
  ]);
  const counts = {};
  if (nights?.length) {
    const { data: bks } = await sb.from("bookings").select("night_id,status").in("night_id", nights.map((n) => n.id));
    (bks || []).forEach((b) => { if (b.status === "booked") counts[b.night_id] = (counts[b.night_id] || 0) + 1; });
  }

  const local = (d) => { const x = new Date(d); x.setMinutes(x.getMinutes() - x.getTimezoneOffset()); return x.toISOString().slice(0, 16); };
  const nextWed = (() => { const d = new Date(); d.setDate(d.getDate() + ((3 - d.getDay() + 7) % 7 || 7)); d.setHours(21, 0, 0, 0); return d; })();

  $app.innerHTML = `
    <h1 style="font-size:2.2rem">Admin</h1>
    <div class="card">
      <h3>New Supper Night</h3>
      <div class="grid">
        <div><label>Starts</label><input type="datetime-local" id="ns" value="${local(nextWed)}" /></div>
        <div><label>After-supper spot (optional)</label><input id="na" placeholder="e.g. night market entrance" /></div>
        <div><label>After-spot address</label><input id="naa" /></div>
      </div>
      <p class="small muted">Booking closes 2 days before · table revealed 1 day before · location revealed 9h before · after-spot 1.5h after start.</p>
      <button class="btn orange" id="create">Create</button>
    </div>
    ${(nights || []).map((n) => `<div class="card">
      <div class="night"><div><div class="date">${fmtDate(n.starts_at)}</div>
        <span class="small muted">${n.status} · ${counts[n.id] || 0} booked</span></div>
        <div class="row">
          <button class="btn small" data-form="${n.id}">Form tables</button>
          <button class="btn ghost small" data-show="${n.id}">Show tables</button>
          <button class="btn ghost small" data-close="${n.id}">${n.status === "open" ? "Close booking" : "Reopen"}</button>
        </div></div>
      <div id="g-${n.id}"></div></div>`).join("")}
    <div class="card"><h3>Reports</h3>
      ${(reports || []).length ? `<table class="admin"><tr><th>When</th><th>Reporter</th><th>Reported</th><th>Reason</th></tr>
      ${(reports || []).map((r) => `<tr><td>${fmtDate(r.created_at)}</td><td class="small">${esc((r.reporter || "deleted").slice(0, 8))}</td><td class="small">${esc(r.reported_email || (r.reported || "").slice(0, 8))}</td><td>${esc(r.reason)}</td></tr>`).join("")}</table>` : `<p class="muted">None 🎉</p>`}
    </div>`;

  document.getElementById("create").onclick = async () => {
    const s = new Date(document.getElementById("ns").value);
    const h = (n) => new Date(s.getTime() + n * 36e5).toISOString();
    const after = document.getElementById("na").value.trim();
    const { error } = await sb.from("supper_nights").insert({
      starts_at: s.toISOString(), booking_closes_at: h(-48), stats_reveal_at: h(-24), location_reveal_at: h(-9),
      after_spot_name: after || null, after_spot_address: document.getElementById("naa").value.trim() || null,
      after_spot_reveal_at: after ? h(1.5) : null,
    });
    if (error) return toast(error.message, true);
    toast("Created"); renderAdmin();
  };
  $app.querySelectorAll("[data-close]").forEach((b) => (b.onclick = async () => {
    const n = nights.find((x) => x.id === b.dataset.close);
    await sb.from("supper_nights").update({ status: n.status === "open" ? "closed" : "open" }).eq("id", n.id);
    renderAdmin();
  }));
  $app.querySelectorAll("[data-form]").forEach((b) => (b.onclick = async () => {
    if (!confirm("Form tables now? This replaces any existing tables for this night.")) return;
    const { data, error } = await sb.rpc("form_groups", { p_night: b.dataset.form, p_size: 6 });
    if (error) return toast(error.message, true);
    toast(`${data} tables formed`); showGroups(b.dataset.form);
  }));
  $app.querySelectorAll("[data-show]").forEach((b) => (b.onclick = () => showGroups(b.dataset.show)));

  async function showGroups(nid) {
    const box = document.getElementById("g-" + nid);
    const { data, error } = await sb.rpc("admin_night_groups", { p_night: nid });
    if (error) return toast(error.message, true);
    box.innerHTML = (data || []).map((g, i) => `<div class="reveal-box open">
      <h4>Table ${i + 1} · ${(g.members || []).length} people</h4>
      <p class="small">${(g.members || []).map((m) => `<span class="tag ${m.school}">${m.school}</span> ${esc(m.name || "?")} (${esc(m.dept || "")})`).join(" · ")}</p>
      <div class="grid"><input placeholder="Restaurant" value="${esc(g.restaurant_name || "")}" id="rn-${g.group_id}" />
        <input placeholder="Address" value="${esc(g.restaurant_address || "")}" id="ra-${g.group_id}" /></div>
      <button class="btn small" style="margin-top:8px" data-save="${g.group_id}">Save restaurant</button></div>`).join("") || `<p class="muted">No tables yet.</p>`;
    box.querySelectorAll("[data-save]").forEach((s) => (s.onclick = async () => {
      const gid = s.dataset.save;
      const { error } = await sb.from("groups").update({
        restaurant_name: document.getElementById("rn-" + gid).value.trim(),
        restaurant_address: document.getElementById("ra-" + gid).value.trim(),
      }).eq("id", gid);
      if (error) return toast(error.message, true);
      toast("Saved");
    }));
  }
}

// ---------- boot ----------
sb.auth.onAuthStateChange((event) => {
  // Defer: calling Supabase inside this callback can deadlock the auth client.
  if (event === "SIGNED_OUT") setTimeout(async () => { await loadMe(); render(); }, 0);
});
window.addEventListener("hashchange", render);
(async () => {
  document.documentElement.lang = state.lang === "zh" ? "zh-Hant" : "en";
  await loadMe();
  render();
})();
