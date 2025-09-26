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

// ===== Collections =====
const USER_COL  = "user";          // role: 0=user, 1=rider
const ADDR_COL  = "user_address";  // address_id, user_id, address, lat, lng
const RIDER_COL = "rider_car";     // rider_id, user_id, image_car, plate_number, car_type
const COUNTERS  = "_counters";     // seq storage

// ===== Health =====
app.get("/", (_, res) => res.send("API is running 🚀"));

/* -------------------------------------------------------------------------- */
/*                          Auto-increment Counter                             */
/* -------------------------------------------------------------------------- */
async function nextId(sequence) {
  const ref = db.collection(COUNTERS).doc(sequence);
  const val = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const current = snap.exists ? Number(snap.data().value || 0) : 0;
    const next = current + 1;
    if (!snap.exists) {
      tx.set(ref, { value: next });
    } else {
      tx.update(ref, { value: next });
    }
    return next;
  });
  return val; // number
}

/* -------------------------------------------------------------------------- */
/*                               Helper funcs                                  */
/* -------------------------------------------------------------------------- */
async function assertPhoneNotDuplicate(phone) {
  const snap = await db
    .collection(USER_COL)
    .where("phone", "==", String(phone))
    .limit(1)
    .get();
  if (!snap.empty) {
    const d = snap.docs[0];
    const err = new Error("phone already exists");
    err.code = 409;
    err.payload = { id: d.id, ...d.data() };
    throw err;
  }
}

function normalizeRoleInt(role) {
  const r = Number(role ?? 0);
  if (r !== 0 && r !== 1) {
    const e = new Error("role must be 0 or 1");
    e.code = 400;
    throw e;
  }
  return r;
}

/* -------------------------------------------------------------------------- */
/*                              Core creators                                  */
/* -------------------------------------------------------------------------- */
async function createUser({ name, password, phone, picture, role }) {
  if (!name || !password || !phone) {
    const e = new Error("name, password, phone are required");
    e.code = 400;
    throw e;
  }
  const roleInt = normalizeRoleInt(role);
  await assertPhoneNotDuplicate(phone);

  const idNum = await nextId("user_seq");      // 1,2,3,...
  const id = String(idNum);

  const data = {
    user_id: idNum,
    name: String(name),
    password: String(password),                // DEMO: โปรดใช้ bcrypt ใน prod
    phone: String(phone),
    picture: picture ? String(picture) : null,
    role: roleInt,
  };

  await db.collection(USER_COL).doc(id).set(data);
  return { id, ...data };
}

async function createAddress({ user_id, address, lat, lng }) {
  if (!user_id || !address) {
    const e = new Error("user_id and address are required");
    e.code = 400;
    throw e;
  }
  const addrIdNum = await nextId("address_seq");
  const addrId = String(addrIdNum);

  const payload = {
    address_id: addrIdNum,
    user_id: isNaN(Number(user_id)) ? String(user_id) : Number(user_id),
    address: String(address),
    lat: lat == null ? null : Number(lat),
    lng: lng == null ? null : Number(lng),
  };

  await db.collection(ADDR_COL).doc(addrId).set(payload);
  return { id: addrId, ...payload };
}

async function createRiderCar({ user_id, image_car, plate_number, car_type }) {
  if (!user_id || !plate_number || !car_type) {
    const e = new Error("user_id, plate_number, car_type are required");
    e.code = 400;
    throw e;
  }
  const riderIdNum = await nextId("rider_seq");
  const riderId = String(riderIdNum);

  const payload = {
    rider_id: riderIdNum,
    user_id: isNaN(Number(user_id)) ? String(user_id) : Number(user_id),
    image_car: image_car ? String(image_car) : null,
    plate_number: String(plate_number),
    car_type: String(car_type),
  };

  await db.collection(RIDER_COL).doc(riderId).set(payload);
  return { id: riderId, ...payload };
}

/* -------------------------------------------------------------------------- */
/*                               Register routes                                */
/* -------------------------------------------------------------------------- */
app.post("/register/user", async (req, res) => {
  try {
    const { name, phone, password, picture } = req.body ?? {};

    // role = 0 สำหรับผู้ใช้ทั่วไป
    const user = await createUser({ name, phone, password, picture, role: 0 });

    // ✅ ไม่สร้าง user_address ในเส้นนี้
    return res.status(201).json({ user });
  } catch (e) {
    return res.status(e.code || 400).json({ error: e.message, ...(e.payload || {}) });
  }
});

app.post("/register/rider", async (req, res) => {
  try {
    const {
      name, phone, password, picture,
      image_car, plate_number, car_type,
    } = req.body ?? {};

    // 1) สร้าง user (role = 1)
    const user = await createUser({ name, phone, password, picture, role: 1 });

    // 2) สร้างข้อมูลรถของไรเดอร์
    const rider_car = await createRiderCar({
      user_id: user.id,
      image_car,
      plate_number,
      car_type,
    });

    // ✅ ไม่สร้าง address ใด ๆ และไม่คืน field address
    return res.status(201).json({ user, rider_car });
  } catch (e) {
    return res.status(e.code || 400).json({ error: e.message, ...(e.payload || {}) });
  }
});

/* -------------------------------------------------------------------------- */
/*                              Other CRUD routes                               */
/* -------------------------------------------------------------------------- */
app.get("/users", async (req, res) => {
  try {
    const limit = Number(req.query.limit || 50);
    let q = db.collection(USER_COL).orderBy("user_id", "asc").limit(limit);
    if (req.query.startAfter) q = q.startAfter(Number(req.query.startAfter));
    const snap = await q.get();
    res.json({ items: snap.docs.map(d => ({ id: d.id, ...d.data() })), count: snap.size });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/users/:id", async (req, res) => {
  try {
    const doc = await db.collection(USER_COL).doc(String(req.params.id)).get();
    if (!doc.exists) return res.status(404).json({ error: "not found" });
    res.json({ id: doc.id, ...doc.data() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

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

app.patch("/users/:id", async (req, res) => {
  try {
    const ref = db.collection(USER_COL).doc(String(req.params.id));
    const before = await ref.get();
    if (!before.exists) return res.status(404).json({ error: "not found" });

    const allowed = ["name","password","phone","picture","role"];
    const patch = {};
    for (const k of allowed) if (k in req.body) patch[k] = req.body[k];
    if ("role" in patch) patch.role = normalizeRoleInt(patch.role);

    if ("phone" in patch && patch.phone) {
      const dup = await db.collection(USER_COL).where("phone","==",String(patch.phone)).limit(1).get();
      if (!dup.empty && dup.docs[0].id !== ref.id)
        return res.status(409).json({ error: "phone already exists" });
    }

    await ref.update(patch);
    const after = await ref.get();
    res.json({ id: after.id, ...after.data() });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete("/users/:id", async (req, res) => {
  try {
    const ref = db.collection(USER_COL).doc(String(req.params.id));
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
    if (!phone || !password)
      return res.status(400).json({ error: "phone and password are required" });

    const snap = await db.collection(USER_COL)
      .where("phone","==",String(phone))
      .limit(1)
      .get();

    if (snap.empty) return res.status(401).json({ error: "invalid credentials" });
    const d = snap.docs[0];
    const u = d.data();
    if (String(u.password) !== String(password))
      return res.status(401).json({ error: "invalid credentials" });

    res.json({ id: d.id, name: u.name, phone: u.phone, role: Number(u.role) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export const api = onRequest({ region: "asia-southeast1", cors: true }, app);

//จบ