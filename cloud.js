/* Forma cloud layer: Firebase Auth + Firestore, loaded from Google's CDN on demand.
   The app works offline and without an account; this file is only used for sign-in and coach sync. */
const cfg = window.FIREBASE_CONFIG || {};
const configured = !!(cfg.apiKey && cfg.projectId && !/PASTE|YOUR/i.test(cfg.apiKey + cfg.projectId));
const BASE = 'https://www.gstatic.com/firebasejs/10.14.1/';
let _sdk = null;

function sdk() {
  if (_sdk) return _sdk;
  _sdk = (async () => {
    const [app, auth, fs] = await Promise.all([
      import(BASE + 'firebase-app.js'),
      import(BASE + 'firebase-auth.js'),
      import(BASE + 'firebase-firestore.js')
    ]);
    const a = app.initializeApp(cfg);
    /* تسجيل الدخول يفضل محفوظ على الجهاز حتى بعد قفل التطبيق */
    let au;
    try { au = auth.initializeAuth(a, { persistence: [auth.indexedDBLocalPersistence, auth.browserLocalPersistence] }); }
    catch (e) { au = auth.getAuth(a); }
    return { auth: au, db: fs.getFirestore(a), A: auth, F: fs };
  })();
  _sdk.catch(() => { _sdk = null; });
  return _sdk;
}

const clean = o => JSON.parse(JSON.stringify(o)); /* Firestore rejects undefined values */

/* يمسح كل مستندات مجموعة فرعية على دفعات */
async function wipeSub(s, uid, name) {
  const snap = await s.F.getDocs(s.F.collection(s.db, 'users', uid, name));
  let batch = s.F.writeBatch(s.db), n = 0;
  for (const d of snap.docs) {
    batch.delete(d.ref); n++;
    if (n === 400) { await batch.commit(); batch = s.F.writeBatch(s.db); n = 0; }
  }
  if (n) await batch.commit();
}

const Cloud = {
  configured,

  async onAuth(cb) {
    if (!configured) { cb(null); return () => {}; }
    try {
      const s = await sdk();
      return s.A.onAuthStateChanged(s.auth, u => cb(u ? { uid: u.uid, email: u.email } : null));
    } catch (e) { cb(null); return () => {}; }
  },
  async signUp(email, pw) {
    const s = await sdk();
    const r = await s.A.createUserWithEmailAndPassword(s.auth, email, pw);
    return { uid: r.user.uid, email: r.user.email };
  },
  async signIn(email, pw) {
    const s = await sdk();
    const r = await s.A.signInWithEmailAndPassword(s.auth, email, pw);
    return { uid: r.user.uid, email: r.user.email };
  },
  async signOut() { const s = await sdk(); await s.A.signOut(s.auth); },
  async reset(email) { const s = await sdk(); await s.A.sendPasswordResetEmail(s.auth, email); },
  /* تأكيد الباسورد قبل العمليات الحساسة (مسح الحساب) */
  async reauth(pw) {
    const s = await sdk();
    const u = s.auth.currentUser;
    if (!u) throw new Error('no-user');
    await s.A.reauthenticateWithCredential(u, s.A.EmailAuthProvider.credential(u.email, pw));
  },
  /* مسح الحساب وكل بياناته نهائياً: المحادثات والخطة والبيانات والصور وبعدين الحساب نفسه */
  async deleteAccount(uid, code) {
    const s = await sdk();
    for (const sub of ['data', 'plan', 'messages', 'photos']) await wipeSub(s, uid, sub);
    try { await s.F.deleteDoc(s.F.doc(s.db, 'pushSubs', uid)); } catch (e) {}
    try { await s.F.deleteDoc(s.F.doc(s.db, 'payInfo', uid)); } catch (e) {}
    try {
      const q = await s.F.getDocs(s.F.query(s.F.collection(s.db, 'payReqs'), s.F.where('from', '==', uid)));
      for (const d of q.docs) { try { await s.F.deleteDoc(d.ref); } catch (e) {} }
    } catch (e) {}
    if (code) { try { await s.F.deleteDoc(s.F.doc(s.db, 'coachCodes', code)); } catch (e) {} }
    await s.F.deleteDoc(s.F.doc(s.db, 'users', uid));
    await s.A.deleteUser(s.auth.currentUser);
  },

  async profile(uid) {
    const s = await sdk();
    const d = await s.F.getDoc(s.F.doc(s.db, 'users', uid));
    return d.exists() ? d.data() : null;
  },
  async setProfile(uid, data) {
    const s = await sdk();
    await s.F.setDoc(s.F.doc(s.db, 'users', uid), clean(data), { merge: true });
  },

  async watchProfile(uid, cb) {
    const s = await sdk();
    return s.F.onSnapshot(s.F.doc(s.db, 'users', uid), d => cb(d.exists() ? d.data() : null), () => {});
  },
  async watchCoaches(cb) {
    const s = await sdk();
    const q = s.F.query(s.F.collection(s.db, 'users'), s.F.where('role', '==', 'coach'));
    return s.F.onSnapshot(q, snap => cb(snap.docs.map(d => Object.assign({ uid: d.id }, d.data()))), () => cb([]));
  },
  async countClients(uid) {
    const s = await sdk();
    const r = await s.F.getCountFromServer(s.F.query(s.F.collection(s.db, 'users'), s.F.where('coachId', '==', uid)));
    return r.data().count;
  },

  async coachByCode(code) {
    const s = await sdk();
    const d = await s.F.getDoc(s.F.doc(s.db, 'coachCodes', code));
    return d.exists() ? d.data() : null;
  },
  async createCode(code, coachId, name) {
    const s = await sdk();
    await s.F.setDoc(s.F.doc(s.db, 'coachCodes', code), clean({ coachId, name }));
  },

  async writeChunk(uid, id, obj) {
    const s = await sdk();
    await s.F.setDoc(s.F.doc(s.db, 'users', uid, 'data', id), clean(obj));
  },
  async deleteChunk(uid, id) {
    const s = await sdk();
    await s.F.deleteDoc(s.F.doc(s.db, 'users', uid, 'data', id));
  },
  async readChunks(uid) {
    const s = await sdk();
    const snap = await s.F.getDocs(s.F.collection(s.db, 'users', uid, 'data'));
    const out = {};
    snap.forEach(d => { out[d.id] = d.data(); });
    return out;
  },

  /* صور التقدم (قبل/بعد) */
  async listPhotos(uid) {
    const s = await sdk();
    const snap = await s.F.getDocs(s.F.query(s.F.collection(s.db, 'users', uid, 'photos'), s.F.orderBy('ts')));
    return snap.docs.map(d => Object.assign({ id: d.id }, d.data()));
  },
  async addPhoto(uid, obj) {
    const s = await sdk();
    const r = await s.F.addDoc(s.F.collection(s.db, 'users', uid, 'photos'), clean(obj));
    return r.id;
  },
  async delPhoto(uid, id) {
    const s = await sdk();
    await s.F.deleteDoc(s.F.doc(s.db, 'users', uid, 'photos', id));
  },

  async getPlan(uid) {
    const s = await sdk();
    const d = await s.F.getDoc(s.F.doc(s.db, 'users', uid, 'plan', 'current'));
    return d.exists() ? d.data() : null;
  },
  async setPlan(uid, obj) {
    const s = await sdk();
    await s.F.setDoc(s.F.doc(s.db, 'users', uid, 'plan', 'current'), clean(obj));
  },
  async watchPlan(uid, cb) {
    const s = await sdk();
    return s.F.onSnapshot(s.F.doc(s.db, 'users', uid, 'plan', 'current'), snap => cb(snap.exists() ? snap.data() : null), () => {});
  },

  async watchClients(coachId, cb) {
    const s = await sdk();
    const q = s.F.query(s.F.collection(s.db, 'users'), s.F.where('coachId', '==', coachId));
    return s.F.onSnapshot(q, snap => cb(snap.docs.map(d => Object.assign({ uid: d.id }, d.data()))), () => cb([]));
  },
  async watchMessages(uid, cb) {
    const s = await sdk();
    const q = s.F.query(s.F.collection(s.db, 'users', uid, 'messages'), s.F.orderBy('ts'));
    return s.F.onSnapshot(q, snap => cb(snap.docs.map(d => Object.assign({ id: d.id }, d.data()))), () => cb([]));
  },
  async idToken() {
    const s = await sdk();
    return s.auth.currentUser ? await s.auth.currentUser.getIdToken() : null;
  },
  async _pushList(uid) {
    const s = await sdk();
    const d = await s.F.getDoc(s.F.doc(s.db, 'pushSubs', uid));
    const arr = d.exists() ? (d.data().subs || []) : [];
    return arr.map(x => { try { return JSON.parse(x); } catch (e) { return null; } }).filter(Boolean);
  },
  async addPushSub(uid, rec) {
    const s = await sdk();
    const arr = (await Cloud._pushList(uid)).filter(x => x.endpoint !== rec.endpoint);
    arr.unshift(rec);
    await s.F.setDoc(s.F.doc(s.db, 'pushSubs', uid), { subs: arr.slice(0, 5).map(x => JSON.stringify(x)) });
  },
  async removePushSub(uid, endpoint) {
    const s = await sdk();
    const arr = (await Cloud._pushList(uid)).filter(x => x.endpoint !== endpoint);
    await s.F.setDoc(s.F.doc(s.db, 'pushSubs', uid), { subs: arr.map(x => JSON.stringify(x)) });
  },
  async adminInfo() {
    const s = await sdk();
    const d = await s.F.getDoc(s.F.doc(s.db, 'adminInfo', 'main'));
    return d.exists() ? d.data() : null;
  },
  async setAdminInfo(data) {
    const s = await sdk();
    await s.F.setDoc(s.F.doc(s.db, 'adminInfo', 'main'), clean(data));
  },
  /* ----- الاشتراك / التجديد ----- */
  async payInfo(uid) {
    const s = await sdk();
    const d = await s.F.getDoc(s.F.doc(s.db, 'payInfo', uid));
    return d.exists() ? d.data() : null;
  },
  async setPayInfo(uid, data) {
    const s = await sdk();
    await s.F.setDoc(s.F.doc(s.db, 'payInfo', uid), clean(data));
  },
  async createPayReq(obj) {
    const s = await sdk();
    const r = await s.F.addDoc(s.F.collection(s.db, 'payReqs'), clean(obj));
    return r.id;
  },
  async watchPayReqs(field, uid, cb) {
    const s = await sdk();
    const q = s.F.query(s.F.collection(s.db, 'payReqs'), s.F.where(field, '==', uid));
    return s.F.onSnapshot(q, snap => cb(snap.docs.map(d => Object.assign({ id: d.id }, d.data())).sort((a, b) => (b.ts || 0) - (a.ts || 0))), () => cb([]));
  },
  async updatePayReq(id, patch) {
    const s = await sdk();
    await s.F.updateDoc(s.F.doc(s.db, 'payReqs', id), clean(patch));
  },
  async allClients(max) {
    const s = await sdk();
    const q = await s.F.getDocs(s.F.query(s.F.collection(s.db, 'users'), s.F.where('role', '==', 'client'), s.F.limit(max || 500)));
    return q.docs.map(d => { const x = d.data(); return { uid: d.id, role: 'client', name: x.name || '', email: x.email || '', phone: x.phone || '', coachId: x.coachId || null, coachName: x.coachName || '', until: x.until || null, blocked: !!x.blocked, createdAt: x.createdAt || 0 }; });
  },
  async deletePayReq(id) {
    const s = await sdk();
    await s.F.deleteDoc(s.F.doc(s.db, 'payReqs', id));
  },
  async sendMessage(uid, msg) {
    const s = await sdk();
    await s.F.addDoc(s.F.collection(s.db, 'users', uid, 'messages'), clean(msg));
  }
};

window.Cloud = Cloud;
window.dispatchEvent(new Event('cloud-ready'));
