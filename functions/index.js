// functions/index.js

import express from "express";                     // ใช้ Express แบบเดิมได้
import cors from "cors";
import admin from "firebase-admin";
import { onRequest } from "firebase-functions/v2/https";

admin.initializeApp();                             // บน emulator/production ใช้ default creds ได้เลย
const db = admin.firestore();                      // อ็อบเจ็กต์ Firestore (จะชี้ emulator อัตโนมัติเมื่อใช้ emulators)

const app = express();
app.use(cors({ origin: true }));                   // เปิด CORS ชั่วคราว (ปรับ origin ในโปรดักชัน)
app.use(express.json());                           // parse JSON

const COL = "user";                                // คอลเลกชันตามที่คุณใช้อยู่

// ---------- Routes เหมือน Express เดิม ----------
app.get("/", (_, res) => res.send("Functions API is running 🚀"));
// POST /api/users  สร้างผู้ใช้ใหม่ (กันเบอร์ซ้ำ)
app.post("/users", async (req, res) => {
  try {
    const { name, password, phone, picture, role } = req.body ?? {};
    if (!name || !password || !phone) throw new Error("name, password, phone are required");
    const roleNum = role === undefined ? 0 : Number(role);
    if (![0,1].includes(roleNum)) throw new Error("role must be 0 or 1");

    const dup = await db.collection(COL).where("phone","==",String(phone)).limit(1).get();
    if (!dup.empty) return res.status(409).json({ error: "phone already exists" });

    const ref = await db.collection(COL).add({
      name: String(name),
      password: String(password),                 // เดโม: เก็บตรง ๆ (ของจริงให้ใช้ bcrypt)
      phone: String(phone),
      picture: picture ? String(picture) : null,
      role: roleNum
    });
    const doc = await ref.get();
    res.status(201).json({ id: ref.id, ...doc.data() });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// GET /api/users  ดึงทั้งหมด (รองรับ ?limit= & ?startAfter=<phone>)
app.get("/users", async (req, res) => {
  try {
    const limit = Number(req.query.limit || 50);
    let q = db.collection(COL).orderBy("phone","asc").limit(limit);
    if (req.query.startAfter) q = q.startAfter(String(req.query.startAfter));
    const snap = await q.get();
    res.json({ items: snap.docs.map(d => ({ id: d.id, ...d.data() })), count: snap.size });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/users/:id  ดึงตาม id
app.get("/users/:id", async (req, res) => {
  try {
    const doc = await db.collection(COL).doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: "not found" });
    res.json({ id: doc.id, ...doc.data() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/users/by-phone/:phone  ดึงตามเบอร์
app.get("/users/by-phone/:phone", async (req, res) => {
  try {
    const snap = await db.collection(COL).where("phone","==",String(req.params.phone)).limit(1).get();
    if (snap.empty) return res.status(404).json({ error: "not found" });
    const doc = snap.docs[0];
    res.json({ id: doc.id, ...doc.data() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/users/:id  อัปเดตบางฟิลด์
app.patch("/users/:id", async (req, res) => {
  try {
    const ref = db.collection(COL).doc(req.params.id);
    const before = await ref.get();
    if (!before.exists) return res.status(404).json({ error: "not found" });

    const allowed = ["name","password","phone","picture","role"];
    const patch = {};
    for (const k of allowed) if (k in req.body) patch[k] = req.body[k];
    if ("role" in patch) patch.role = Number(patch.role);

    if (patch.phone) {
      const dup = await db.collection(COL).where("phone","==",String(patch.phone)).limit(1).get();
      if (!dup.empty && dup.docs[0].id !== req.params.id) return res.status(409).json({ error: "phone already exists" });
    }

    await ref.update(patch);
    const after = await ref.get();
    res.json({ id: after.id, ...after.data() });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// DELETE /api/users/:id  ลบ
app.delete("/users/:id", async (req, res) => {
  try {
    const ref = db.collection(COL).doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: "not found" });
    await ref.delete();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/login", async (req, res) => {
  try {
    const { phone, password } = req.body ?? {};
    if (!phone || !password) return res.status(400).json({ error: "phone and password are required" });
    const snap = await db.collection(COL).where("phone","==",String(phone)).limit(1).get();
    if (snap.empty) return res.status(401).json({ error: "invalid credentials" });
    const u = snap.docs[0].data();
    if (String(u.password) !== String(password)) return res.status(401).json({ error: "invalid credentials" });
    res.json({ id: snap.docs[0].id, name: u.name, phone: u.phone, role: u.role });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== user_address endpoints =====
const ADDR_COL = "user_address";

// POST /addresses  -> สร้างที่อยู่ของผู้ใช้
app.post("/addresses", async (req, res) => {
  try {
    const { user_id, address, lat, lng } = req.body ?? {};
    if (!user_id || !address) return res.status(400).json({ error: "user_id and address are required" });

    // ตรวจว่าผู้ใช้มีจริง
    const u = await db.collection(COL).doc(String(user_id)).get();
    if (!u.exists) return res.status(404).json({ error: "user not found" });

    const ref = await db.collection(ADDR_COL).add({
      user_id: String(user_id),
      address: String(address),
      lat: lat === undefined ? null : Number(lat),
      lng: lng === undefined ? null : Number(lng),
    });

    const doc = await ref.get();
    res.status(201).json({ address_id: ref.id, ...doc.data() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /addresses?user_id=...  -> ดึงที่อยู่ทั้งหมดของ user
app.get("/addresses", async (req, res) => {
  try {
    const uid = req.query.user_id;
    let q = db.collection(ADDR_COL);
    if (uid) q = q.where("user_id", "==", String(uid));
    const snap = await q.get();
    res.json({ items: snap.docs.map(d => ({ address_id: d.id, ...d.data() })), count: snap.size });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


export const api = onRequest({ region: "asia-southeast1", cors: true }, app);
