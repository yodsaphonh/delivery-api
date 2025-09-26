// functions/index.js
import express from "express";
import cors from "cors";
import admin from "firebase-admin";
import { onRequest } from "firebase-functions/v2/https";

admin.initializeApp();
const db = admin.firestore();

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

// ==== Collections ตาม ER ====
const USER_COL  = "user";          // user (role: 0=user, 1=rider)
const ADDR_COL  = "user_address";  // address_id, user_id, address, lat, lng
const RIDER_COL = "rider_car";     // rider_id, user_id, image_car, plate_number, car_type

// ---------- Health ----------
app.get("/", (_, res) => res.send("Functions API is running 🚀"));

/* -------------------------------------------------------------------------- */
/*                               Helper functions                             */
/* -------------------------------------------------------------------------- */

// เช็คซ้ำเบอร์ใน collection user
async function assertPhoneNotDuplicate(phone) {
  const snap = await db.collection(USER_COL)
    .where("phone", "==", String(phone))
    .limit(1)
    .get();
  if (!snap.empty) {
    const owner = snap.docs[0];
    const u = owner.data();
    const err = new Error("phone already exists");
    err.code = 409;
    err.payload = { id: owner.id, phone: u.phone, name: u.name };
    throw err;
  }
}

// สร้าง user (คืน {id, ...data})
async function createUser({ name, password, phone, picture, role }) {
  if (!name || !password || !phone) {
    const e = new Error("name, password, phone are required");
    e.code = 400;
    throw e;
  }
  const roleNum = role === undefined ? 0 : Number(role);
  if (![0, 1].includes(roleNum)) {
    const e = new Error("role must be 0 or 1");
    e.code = 400;
    throw e;
  }

  await assertPhoneNotDuplicate(phone);

  const ref = await db.collection(USER_COL).add({
    name: String(name),
    password: String(password),   // เดโม: เก็บตรง ๆ; โปรดใช้ bcrypt ในโปรดักชัน
    phone: String(phone),
    picture: picture ? String(picture) : null,
    role: roleNum,
  });
  const doc = await ref.get();
  return { id: ref.id, ...doc.data() };
}

// เพิ่มที่อยู่ (คืน {id, ...})
async function createAddress({ user_id, address, lat, lng }) {
  if (!user_id || !address) {
    const e = new Error("user_id and address are required");
    e.code = 400;
    throw e;
  }
  const payload = {
    user_id: String(user_id),
    address: String(address),
    lat: lat === undefined || lat === null ? null : Number(lat),
    lng: lng === undefined || lng === null ? null : Number(lng),
  };
  const ref = await db.collection(ADDR_COL).add(payload);
  const doc = await ref.get();
  return { id: ref.id, ...doc.data() };
}

// เพิ่มข้อมูลรถไรเดอร์ (คืน {id, ...})
async function createRiderCar({ user_id, image_car, plate_number, car_type }) {
  if (!user_id || !plate_number || !car_type) {
    const e = new Error("user_id, plate_number, car_type are required");
    e.code = 400;
    throw e;
  }
  const payload = {
    user_id: String(user_id),
    image_car: image_car ? String(image_car) : null,
    plate_number: String(plate_number),
    car_type: String(car_type), // e.g., "motorcycle" | "car" | "pickup"
  };
  const ref = await db.collection(RIDER_COL).add(payload);
  const doc = await ref.get();
  return { id: ref.id, ...doc.data() };
}

/* -------------------------------------------------------------------------- */
/*                               REGISTER ROUTES                               */
/* -------------------------------------------------------------------------- */

/**
 * POST /register/user
 * สมัครผู้ใช้ทั่วไป (role=0)
 * body:
 * {
 *   "name": "...", "phone": "...", "password": "...",
 *   "picture": "http(s)://..." (optional)
 * }
 * -> สร้าง user อย่างเดียว (ที่อยู่ค่อยยิงอีกเส้น)
 */
app.post("/register/user", async (req, res) => {
  try {
    const { name, phone, password, picture } = req.body ?? {};
    const user = await createUser({ name, phone, password, picture, role: 0 });
    return res.status(201).json({ user });
  } catch (e) {
    return res.status(e.code || 400).json({ error: e.message, ...(e.payload || {}) });
  }
});

/**
 * POST /register/rider
 * สมัครไรเดอร์ (role=1) + บันทึกข้อมูลรถ
 * body:
 * {
 *   "name":"...", "phone":"...", "password":"...", "picture":"(optional)",
 *   "image_car":"(optional)", "plate_number":"...", "car_type":"..."
 * }
 * -> คืนทั้ง user และ rider_car
 */
app.post("/register/rider", async (req, res) => {
  try {
    const {
      name, phone, password, picture,
      image_car, plate_number, car_type
    } = req.body ?? {};

    // 1) create user (role=1)
    const user = await createUser({ name, phone, password, picture, role: 1 });

    // 2) create rider_car
    const rider_car = await createRiderCar({
      user_id: user.id,
      image_car,
      plate_number,
      car_type,
    });

    return res.status(201).json({ user, rider_car });
  } catch (e) {
    return res.status(e.code || 400).json({ error: e.message, ...(e.payload || {}) });
  }
});

/**
 * POST /users/:id/addresses
 * เพิ่มที่อยู่ให้ user ภายหลัง (ตามที่บอกว่า "สมัครก่อน แล้วค่อยเพิ่มที่อยู่")
 * body: { "address":"...", "lat":10.25 (optional), "lng":50.52 (optional) }
 */
app.post("/users/:id/addresses", async (req, res) => {
  try {
    const user_id = String(req.params.id);
    // ตรวจว่ามี user นี้จริง
    const udoc = await db.collection(USER_COL).doc(user_id).get();
    if (!udoc.exists) return res.status(404).json({ error: "user not found" });

    const { address, lat, lng } = req.body ?? {};
    const addr = await createAddress({ user_id, address, lat, lng });
    return res.status(201).json({ address: addr });
  } catch (e) {
    return res.status(e.code || 400).json({ error: e.message });
  }
});

/* -------------------------------------------------------------------------- */
/*                            ROUTES อื่น ๆ (ของเดิม)                         */
/* -------------------------------------------------------------------------- */

// สร้างผู้ใช้แบบ generic (ของเดิมคุณ) — คงไว้เผื่อใช้
app.post("/users", async (req, res) => {
  try {
    const { name, password, phone, picture, role } = req.body ?? {};
    const user = await createUser({ name, password, phone, picture, role });
    res.status(201).json(user);
  } catch (e) {
    res.status(e.code || 400).json({ error: e.message, ...(e.payload || {}) });
  }
});

// GET /users
app.get("/users", async (req, res) => {
  try {
    const limit = Number(req.query.limit || 50);
    let q = db.collection(USER_COL).orderBy("phone", "asc").limit(limit);
    if (req.query.startAfter) q = q.startAfter(String(req.query.startAfter));
    const snap = await q.get();
    res.json({ items: snap.docs.map(d => ({ id: d.id, ...d.data() })), count: snap.size });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /users/:id
app.get("/users/:id", async (req, res) => {
  try {
    const doc = await db.collection(USER_COL).doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: "not found" });
    res.json({ id: doc.id, ...doc.data() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /users/by-phone/:phone
app.get("/users/by-phone/:phone", async (req, res) => {
  try {
    const snap = await db.collection(USER_COL).where("phone","==",String(req.params.phone)).limit(1).get();
    if (snap.empty) return res.status(404).json({ error: "not found" });
    const doc = snap.docs[0];
    res.json({ id: doc.id, ...doc.data() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PATCH /users/:id
app.patch("/users/:id", async (req, res) => {
  try {
    const ref = db.collection(USER_COL).doc(req.params.id);
    const before = await ref.get();
    if (!before.exists) return res.status(404).json({ error: "not found" });

    const allowed = ["name","password","phone","picture","role"];
    const patch = {};
    for (const k of allowed) if (k in req.body) patch[k] = req.body[k];
    if ("role" in patch) patch.role = Number(patch.role);

    if (patch.phone) {
      const dup = await db.collection(USER_COL).where("phone","==",String(patch.phone)).limit(1).get();
      if (!dup.empty && dup.docs[0].id !== req.params.id)
        return res.status(409).json({ error: "phone already exists" });
    }

    await ref.update(patch);
    const after = await ref.get();
    res.json({ id: after.id, ...after.data() });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// DELETE /users/:id
app.delete("/users/:id", async (req, res) => {
  try {
    const ref = db.collection(USER_COL).doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: "not found" });
    await ref.delete();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /login (เหมือนเดิม)
app.post("/login", async (req, res) => {
  try {
    const { phone, password } = req.body ?? {};
    if (!phone || !password)
      return res.status(400).json({ error: "phone and password are required" });

    const snap = await db.collection(USER_COL)
      .where("phone","==",String(phone))
      .limit(1)
      .get();

    if (snap.empty) return res.status(401).json({ error: "invalid credentials" });
    const u = snap.docs[0].data();
    if (String(u.password) !== String(password))
      return res.status(401).json({ error: "invalid credentials" });

    res.json({ id: snap.docs[0].id, name: u.name, phone: u.phone, role: u.role });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export const api = onRequest({ region: "asia-southeast1", cors: true }, app);
