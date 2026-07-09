/**
 * server.js — ระบบจองห้องประชุม
 * สำนักเทคโนโลยีชีวภัณฑ์สัตว์ (DLD)
 *
 * Stack : Node.js + Express + MongoDB (Mongoose) + JWT
 * Run   : node server.js  (หรือ npm start)
 */

'use strict';

const express    = require('express');
const mongoose   = require('mongoose');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const cors       = require('cors');
const path       = require('path');
const crypto     = require('crypto');
require('dotenv').config();

/* ─────────────────────────────────────────────────────
   CONFIG
───────────────────────────────────────────────────── */
const PORT       = process.env.PORT       || 5000;
const MONGO_URI  = process.env.MONGO_URI  || 'mongodb://127.0.0.1:27017/dld_meetingroom';
const JWT_SECRET = process.env.JWT_SECRET || 'change_this_secret_in_production';
const JWT_EXPIRE = process.env.JWT_EXPIRE || '7d';
const SALT_ROUNDS = 10;

/* ─────────────────────────────────────────────────────
   DATABASE
───────────────────────────────────────────────────── */
mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 5000 })
  .then(function () { console.log('[DB] MongoDB connected →', MONGO_URI); })
  .catch(function (err) { console.error('[DB] Connection failed:', err.message); process.exit(1); });

/* ─────────────────────────────────────────────────────
   SCHEMAS & MODELS
───────────────────────────────────────────────────── */

/* ── User ─── */
var UserSchema = new mongoose.Schema({
  prefix:     { type: String, default: 'นาย' },
  firstName:  { type: String, required: true },
  lastName:   { type: String, required: true },
  email:      { type: String, required: true, unique: true, lowercase: true, trim: true },
  password:   { type: String, required: true, select: false },
  phone:      { type: String, default: '' },
  department: { type: String, default: '' },
  position:   { type: String, default: '' },
  role:       { type: String, enum: ['user','admin'], default: 'user' },
  status:     { type: String, enum: ['pending','active','inactive'], default: 'pending' },
  twoFA:      { type: Boolean, default: false },
  notifPrefs: {
    approved: { type: Boolean, default: true },
    rejected: { type: Boolean, default: true },
    reminder: { type: Boolean, default: true },
    system:   { type: Boolean, default: false }
  },
  lastLogin:  { type: Date }
}, { timestamps: true });

/* Hash password before save */
UserSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, SALT_ROUNDS);
  next();
});

/* Instance method — compare password */
UserSchema.methods.comparePassword = function (plain) {
  return bcrypt.compare(plain, this.password);
};

/* Virtual — full name */
UserSchema.virtual('fullName').get(function () {
  return this.prefix + this.firstName + ' ' + this.lastName;
});

var User = mongoose.model('User', UserSchema);

/* ── Room ─── */
var RoomSchema = new mongoose.Schema({
  name:       { type: String, required: true },
  location:   { type: String, required: true },
  capacity:   { type: Number, required: true, min: 1 },
  description:{ type: String, default: '' },
  imageUrl:   { type: String, default: '' },
  status:     { type: String, enum: ['active','maintenance','inactive'], default: 'active' },
  services:   [{ type: String }]           // e.g. ['projector','whiteboard','video_conference']
}, { timestamps: true });

var Room = mongoose.model('Room', RoomSchema);

/* ── Booking ───
 * NOTE: การจองแบบ "walk-up" (ไม่ต้อง login) จะไม่มี user แต่จะเก็บ
 * bookerName / bookerDepartment แทน เพื่อให้แม่บ้าน/ผู้ดูแลห้องรู้ว่าใครจอง
 */
var BookingSchema = new mongoose.Schema({
  user:          { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // optional (walk-up booking ไม่มี user)
  bookerName:       { type: String, default: '' },  // ชื่อ-นามสกุล ผู้จอง (walk-up)
  bookerDepartment: { type: String, default: '' },  // แผนก ผู้จอง (walk-up)
  room:          { type: mongoose.Schema.Types.ObjectId, ref: 'Room', required: true },
  title:         { type: String, required: true },
  purpose:       { type: String, default: '' },
  date:          { type: String, required: true },    // YYYY-MM-DD
  startTime:     { type: String, required: true },    // HH:mm
  endTime:       { type: String, required: true },    // HH:mm
  attendees:     { type: Number, default: 1, min: 1 },
  status:        { type: String, enum: ['pending','approved','rejected','cancelled'], default: 'pending' },
  rejectionReason: { type: String, default: '' },
  approvedBy:    { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  approvedAt:    { type: Date }
}, { timestamps: true });

/* Virtual — display name regardless of walk-up or logged-in booking */
BookingSchema.virtual('displayName').get(function () {
  return this.bookerName || '';
});

var Booking = mongoose.model('Booking', BookingSchema);

/* ─────────────────────────────────────────────────────
   MIDDLEWARE
───────────────────────────────────────────────────── */
var app = express();

app.use(cors({ origin: process.env.CLIENT_ORIGIN || '*', credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* Serve static frontend files */
app.use(express.static(path.join(__dirname)));

/* ── Auth middleware ── */
function authRequired(req, res, next) {
  var header = req.headers['authorization'] || '';
  var token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'กรุณาเข้าสู่ระบบ' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Token ไม่ถูกต้องหรือหมดอายุ' });
  }
}

/* ── Admin-only middleware ── */
function adminRequired(req, res, next) {
  authRequired(req, res, function () {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'สิทธิ์ไม่เพียงพอ' });
    next();
  });
}

/* ── Helpers ── */
function pick(obj, keys) {
  return keys.reduce(function (acc, k) { if (obj[k] !== undefined) acc[k] = obj[k]; return acc; }, {});
}

function makeToken(user) {
  return jwt.sign(
    { id: user._id, email: user.email, role: user.role },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRE }
  );
}

/* ─────────────────────────────────────────────────────
   ROUTES — AUTH
   POST /api/auth/register
   POST /api/auth/login
   GET  /api/auth/me
───────────────────────────────────────────────────── */

/* Register */
app.post('/api/auth/register', async function (req, res) {
  try {
    var { prefix, firstName, lastName, email, password, phone, department, position } = req.body;
    if (!firstName || !lastName || !email || !password)
      return res.status(400).json({ error: 'กรุณากรอกข้อมูลที่จำเป็นให้ครบ' });
    if (password.length < 8)
      return res.status(400).json({ error: 'รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร' });

    var exists = await User.findOne({ email: email.toLowerCase() });
    if (exists) return res.status(409).json({ error: 'อีเมลนี้ถูกใช้งานแล้ว' });

    var user = await User.create({ prefix, firstName, lastName, email, password, phone, department, position });
    res.status(201).json({
      message: 'ลงทะเบียนสำเร็จ รอการอนุมัติจากผู้ดูแลระบบ',
      userId: user._id
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'เกิดข้อผิดพลาดภายในระบบ' });
  }
});

/* Login */
app.post('/api/auth/login', async function (req, res) {
  try {
    var { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'กรุณากรอกอีเมลและรหัสผ่าน' });

    var user = await User.findOne({ email: email.toLowerCase() }).select('+password');
    if (!user) return res.status(401).json({ error: 'อีเมลหรือรหัสผ่านไม่ถูกต้อง' });
    if (!(await user.comparePassword(password)))
      return res.status(401).json({ error: 'อีเมลหรือรหัสผ่านไม่ถูกต้อง' });
    if (user.status === 'pending')
      return res.status(403).json({ error: 'บัญชีของคุณยังรอการอนุมัติจากผู้ดูแลระบบ' });
    if (user.status === 'inactive')
      return res.status(403).json({ error: 'บัญชีของคุณถูกระงับการใช้งาน' });

    user.lastLogin = new Date();
    await user.save();

    var token = makeToken(user);
    res.json({
      token,
      user: {
        id: user._id,
        fullName: user.prefix + user.firstName + ' ' + user.lastName,
        email: user.email,
        department: user.department,
        role: user.role,
        status: user.status
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'เกิดข้อผิดพลาดภายในระบบ' });
  }
});

/* Get current user */
app.get('/api/auth/me', authRequired, async function (req, res) {
  try {
    var user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'ไม่พบผู้ใช้' });
    res.json({
      id: user._id,
      prefix: user.prefix,
      firstName: user.firstName,
      lastName: user.lastName,
      fullName: user.prefix + user.firstName + ' ' + user.lastName,
      email: user.email,
      phone: user.phone,
      department: user.department,
      position: user.position,
      role: user.role,
      status: user.status,
      twoFA: user.twoFA,
      notifPrefs: user.notifPrefs,
      lastLogin: user.lastLogin,
      createdAt: user.createdAt
    });
  } catch (err) {
    res.status(500).json({ error: 'เกิดข้อผิดพลาดภายในระบบ' });
  }
});

/* ─────────────────────────────────────────────────────
   ROUTES — PROFILE
   GET  /api/profile
   PUT  /api/profile
   PUT  /api/profile/password
   PUT  /api/profile/2fa
   PUT  /api/profile/notifications
───────────────────────────────────────────────────── */

app.get('/api/profile', authRequired, async function (req, res) {
  try {
    var user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'ไม่พบผู้ใช้' });

    var totalBookings    = await Booking.countDocuments({ user: req.user.id });
    var approvedBookings = await Booking.countDocuments({ user: req.user.id, status: 'approved' });
    var pendingBookings  = await Booking.countDocuments({ user: req.user.id, status: 'pending' });

    res.json({
      id: user._id,
      prefix: user.prefix,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      phone: user.phone,
      department: user.department,
      position: user.position,
      role: user.role,
      status: user.status,
      twoFA: user.twoFA,
      notifPrefs: user.notifPrefs,
      lastLogin: user.lastLogin,
      createdAt: user.createdAt,
      stats: { totalBookings, approvedBookings, pendingBookings }
    });
  } catch (err) {
    res.status(500).json({ error: 'เกิดข้อผิดพลาดภายในระบบ' });
  }
});

app.put('/api/profile', authRequired, async function (req, res) {
  try {
    var allowed = ['prefix','firstName','lastName','phone','department','position'];
    var updates = pick(req.body, allowed);
    var user    = await User.findByIdAndUpdate(req.user.id, updates, { new: true, runValidators: true });
    if (!user) return res.status(404).json({ error: 'ไม่พบผู้ใช้' });
    res.json({ message: 'บันทึกข้อมูลสำเร็จ', user: pick(user.toObject(), ['_id','prefix','firstName','lastName','email','phone','department','position']) });
  } catch (err) {
    res.status(500).json({ error: 'เกิดข้อผิดพลาดภายในระบบ' });
  }
});

app.put('/api/profile/password', authRequired, async function (req, res) {
  try {
    var { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword)
      return res.status(400).json({ error: 'กรุณากรอกข้อมูลให้ครบถ้วน' });
    if (newPassword.length < 8)
      return res.status(400).json({ error: 'รหัสผ่านใหม่ต้องมีอย่างน้อย 8 ตัวอักษร' });

    var user = await User.findById(req.user.id).select('+password');
    if (!user || !(await user.comparePassword(currentPassword)))
      return res.status(401).json({ error: 'รหัสผ่านปัจจุบันไม่ถูกต้อง' });

    user.password = newPassword;
    await user.save();
    res.json({ message: 'เปลี่ยนรหัสผ่านสำเร็จ' });
  } catch (err) {
    res.status(500).json({ error: 'เกิดข้อผิดพลาดภายในระบบ' });
  }
});

app.put('/api/profile/2fa', authRequired, async function (req, res) {
  try {
    var { enabled } = req.body;
    await User.findByIdAndUpdate(req.user.id, { twoFA: !!enabled });
    res.json({ message: (enabled ? 'เปิด' : 'ปิด') + 'ใช้งาน 2FA แล้ว', twoFA: !!enabled });
  } catch (err) {
    res.status(500).json({ error: 'เกิดข้อผิดพลาดภายในระบบ' });
  }
});

app.put('/api/profile/notifications', authRequired, async function (req, res) {
  try {
    var prefs = pick(req.body, ['approved','rejected','reminder','system']);
    var update = {};
    Object.keys(prefs).forEach(function (k) { update['notifPrefs.' + k] = !!prefs[k]; });
    await User.findByIdAndUpdate(req.user.id, { $set: update });
    res.json({ message: 'บันทึกการตั้งค่าการแจ้งเตือนสำเร็จ' });
  } catch (err) {
    res.status(500).json({ error: 'เกิดข้อผิดพลาดภายในระบบ' });
  }
});

/* ─────────────────────────────────────────────────────
   ROUTES — ROOMS
   GET    /api/rooms          (all active, public)
   GET    /api/rooms/:id
   POST   /api/rooms          (admin)
   PUT    /api/rooms/:id      (admin)
   DELETE /api/rooms/:id      (admin)
───────────────────────────────────────────────────── */

app.get('/api/rooms', authRequired, async function (req, res) {
  try {
    var filter = {};
    if (req.user.role !== 'admin') filter.status = 'active';
    var rooms = await Room.find(filter).sort({ name: 1 });
    res.json(rooms);
  } catch (err) {
    res.status(500).json({ error: 'เกิดข้อผิดพลาดภายในระบบ' });
  }
});

app.get('/api/rooms/:id', authRequired, async function (req, res) {
  try {
    var room = await Room.findById(req.params.id);
    if (!room) return res.status(404).json({ error: 'ไม่พบห้องประชุม' });
    res.json(room);
  } catch (err) {
    res.status(500).json({ error: 'เกิดข้อผิดพลาดภายในระบบ' });
  }
});

app.post('/api/rooms', adminRequired, async function (req, res) {
  try {
    var { name, location, capacity, description, imageUrl, status, services } = req.body;
    if (!name || !location || !capacity)
      return res.status(400).json({ error: 'ชื่อห้อง สถานที่ และความจุเป็นข้อมูลที่จำเป็น' });
    var room = await Room.create({ name, location, capacity, description, imageUrl, status, services });
    res.status(201).json(room);
  } catch (err) {
    res.status(500).json({ error: 'เกิดข้อผิดพลาดภายในระบบ' });
  }
});

app.put('/api/rooms/:id', adminRequired, async function (req, res) {
  try {
    var allowed = ['name','location','capacity','description','imageUrl','status','services'];
    var updates = pick(req.body, allowed);
    var room = await Room.findByIdAndUpdate(req.params.id, updates, { new: true, runValidators: true });
    if (!room) return res.status(404).json({ error: 'ไม่พบห้องประชุม' });
    res.json(room);
  } catch (err) {
    res.status(500).json({ error: 'เกิดข้อผิดพลาดภายในระบบ' });
  }
});

app.delete('/api/rooms/:id', adminRequired, async function (req, res) {
  try {
    var hasActive = await Booking.exists({ room: req.params.id, status: { $in: ['pending','approved'] } });
    if (hasActive) return res.status(409).json({ error: 'ไม่สามารถลบห้องที่มีการจองอยู่ได้' });
    var room = await Room.findByIdAndDelete(req.params.id);
    if (!room) return res.status(404).json({ error: 'ไม่พบห้องประชุม' });
    res.json({ message: 'ลบห้องประชุมสำเร็จ' });
  } catch (err) {
    res.status(500).json({ error: 'เกิดข้อผิดพลาดภายในระบบ' });
  }
});

/* ─────────────────────────────────────────────────────
   ROUTES — PUBLIC (Walk-up booking, ไม่ต้อง login)
   GET  /api/public/rooms
   GET  /api/public/bookings?room=&start=&end=
   POST /api/public/bookings   (ยืนยันทันที ไม่ต้องรออนุมัติ)
   PUT  /api/public/bookings/:id/cancel
───────────────────────────────────────────────────── */

/* รายชื่อห้องที่เปิดให้บริการ (ไม่ต้อง login) */
app.get('/api/public/rooms', async function (req, res) {
  try {
    var rooms = await Room.find({ status: 'active' }).sort({ name: 1 });
    res.json(rooms);
  } catch (err) {
    res.status(500).json({ error: 'เกิดข้อผิดพลาดภายในระบบ' });
  }
});

/* ดึงรายการจองของห้อง ในช่วงวันที่ที่กำหนด สำหรับแสดงบนปฏิทิน (ไม่ต้อง login) */
app.get('/api/public/bookings', async function (req, res) {
  try {
    var { room, start, end } = req.query;
    if (!room) return res.status(400).json({ error: 'กรุณาระบุห้องประชุม' });

    var filter = { room: room, status: { $in: ['pending', 'approved'] } };
    if (start && end) filter.date = { $gte: start, $lte: end };
    else if (start)   filter.date = { $gte: start };

    var bookings = await Booking.find(filter)
      .select('room title date startTime endTime attendees bookerName bookerDepartment status')
      .sort({ date: 1, startTime: 1 });

    res.json(bookings);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'เกิดข้อผิดพลาดภายในระบบ' });
  }
});

/* จองห้อง แบบ walk-up — ไม่ต้อง login ยืนยันทันที */
app.post('/api/public/bookings', async function (req, res) {
  try {
    var { room, bookerName, bookerDepartment, title, date, startTime, endTime, attendees } = req.body;

    if (!room || !bookerName || !bookerName.trim() || !title || !title.trim() || !date || !startTime || !endTime)
      return res.status(400).json({ error: 'กรุณากรอกข้อมูลการจองให้ครบถ้วน (ชื่อ-นามสกุล, หัวข้อ, วันเวลา)' });
    if (startTime >= endTime)
      return res.status(400).json({ error: 'เวลาเริ่มต้นต้องก่อนเวลาสิ้นสุด' });

    var roomDoc = await Room.findById(room);
    if (!roomDoc) return res.status(404).json({ error: 'ไม่พบห้องประชุม' });
    if (roomDoc.status !== 'active')
      return res.status(409).json({ error: 'ห้องประชุมนี้ไม่พร้อมให้บริการ' });

    if (attendees && attendees > roomDoc.capacity)
      return res.status(409).json({ error: 'จำนวนผู้เข้าร่วมเกินความจุห้อง (' + roomDoc.capacity + ' คน)' });

    /* ตรวจสอบเวลาซ้อนทับ */
    var conflict = await Booking.findOne({
      room: room, date: date,
      status: { $in: ['pending', 'approved'] },
      startTime: { $lt: endTime }, endTime: { $gt: startTime }
    });
    if (conflict)
      return res.status(409).json({ error: 'ช่วงเวลานี้ห้องประชุมถูกจองไว้แล้ว' });

    var booking = await Booking.create({
      room: room,
      bookerName: bookerName.trim(),
      bookerDepartment: (bookerDepartment || '').trim(),
      title: title.trim(),
      purpose: (req.body.purpose || '').trim(),
      date: date, startTime: startTime, endTime: endTime,
      attendees: attendees || 1,
      status: 'approved',        // walk-up booking ยืนยันทันที ไม่ต้องรออนุมัติ
      approvedAt: new Date()
    });
    await booking.populate('room', 'name location');
    res.status(201).json(booking);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'เกิดข้อผิดพลาดภายในระบบ' });
  }
});

/* ยกเลิกการจอง walk-up — ต้องระบุชื่อผู้จองตรงกันเพื่อกันคนอื่นมายกเลิกมั่ว */
app.put('/api/public/bookings/:id/cancel', async function (req, res) {
  try {
    var booking = await Booking.findById(req.params.id);
    if (!booking) return res.status(404).json({ error: 'ไม่พบการจอง' });
    if (!['pending', 'approved'].includes(booking.status))
      return res.status(409).json({ error: 'ไม่สามารถยกเลิกการจองที่มีสถานะ ' + booking.status + ' ได้' });

    var { bookerName } = req.body;
    if (booking.bookerName && (!bookerName || bookerName.trim() !== booking.bookerName))
      return res.status(403).json({ error: 'กรุณายืนยันชื่อผู้จองให้ตรงกับตอนที่จองไว้' });

    booking.status = 'cancelled';
    await booking.save();
    res.json({ message: 'ยกเลิกการจองสำเร็จ', booking });
  } catch (err) {
    res.status(500).json({ error: 'เกิดข้อผิดพลาดภายในระบบ' });
  }
});

/* ─────────────────────────────────────────────────────
   ROUTES — BOOKINGS (User)
   GET    /api/bookings          (mine)
   GET    /api/bookings/:id
   POST   /api/bookings          (create)
   PUT    /api/bookings/:id/cancel
───────────────────────────────────────────────────── */

/* List my bookings */
app.get('/api/bookings', authRequired, async function (req, res) {
  try {
    var { status, page, limit, sort } = req.query;
    var filter = { user: req.user.id };
    if (status && status !== 'all') filter.status = status;

    var pageNum  = parseInt(page)  || 1;
    var pageSize = parseInt(limit) || 10;
    var sortBy   = sort === 'oldest' ? { date: 1, startTime: 1 }
                 : sort === 'room'   ? { room: 1 }
                 : { createdAt: -1 };

    var total    = await Booking.countDocuments(filter);
    var bookings = await Booking.find(filter)
      .populate('room', 'name location')
      .sort(sortBy)
      .skip((pageNum - 1) * pageSize)
      .limit(pageSize);

    res.json({ total, page: pageNum, pages: Math.ceil(total / pageSize), bookings });
  } catch (err) {
    res.status(500).json({ error: 'เกิดข้อผิดพลาดภายในระบบ' });
  }
});

/* Get single booking */
app.get('/api/bookings/:id', authRequired, async function (req, res) {
  try {
    var booking = await Booking.findById(req.params.id)
      .populate('room', 'name location capacity')
      .populate('user', 'prefix firstName lastName email department')
      .populate('approvedBy', 'prefix firstName lastName');

    if (!booking) return res.status(404).json({ error: 'ไม่พบการจอง' });

    /* Users can only see their own bookings; admin sees all */
    if (req.user.role !== 'admin' && String(booking.user._id) !== req.user.id)
      return res.status(403).json({ error: 'ไม่มีสิทธิ์เข้าถึงข้อมูลนี้' });

    res.json(booking);
  } catch (err) {
    res.status(500).json({ error: 'เกิดข้อผิดพลาดภายในระบบ' });
  }
});

/* Create booking */
app.post('/api/bookings', authRequired, async function (req, res) {
  try {
    var { room, title, purpose, date, startTime, endTime, attendees } = req.body;
    if (!room || !title || !date || !startTime || !endTime)
      return res.status(400).json({ error: 'กรุณากรอกข้อมูลการจองให้ครบถ้วน' });
    if (startTime >= endTime)
      return res.status(400).json({ error: 'เวลาเริ่มต้นต้องก่อนเวลาสิ้นสุด' });

    /* Check room exists and is active */
    var roomDoc = await Room.findById(room);
    if (!roomDoc) return res.status(404).json({ error: 'ไม่พบห้องประชุม' });
    if (roomDoc.status !== 'active')
      return res.status(409).json({ error: 'ห้องประชุมนี้ไม่พร้อมให้บริการ' });

    /* Check attendees vs capacity */
    if (attendees > roomDoc.capacity)
      return res.status(409).json({ error: `จำนวนผู้เข้าร่วมเกินความจุห้อง (${roomDoc.capacity} คน)` });

    /* Check time conflict on same room/date */
    var conflict = await Booking.findOne({
      room, date,
      status: { $in: ['pending','approved'] },
      $or: [
        { startTime: { $lt: endTime }, endTime: { $gt: startTime } }
      ]
    });
    if (conflict)
      return res.status(409).json({ error: 'ช่วงเวลานี้ห้องประชุมถูกจองไว้แล้ว' });

    var booking = await Booking.create({ user: req.user.id, room, title, purpose, date, startTime, endTime, attendees });
    await booking.populate('room', 'name location');
    res.status(201).json(booking);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'เกิดข้อผิดพลาดภายในระบบ' });
  }
});

/* Cancel booking (owner only, pending/approved → cancelled) */
app.put('/api/bookings/:id/cancel', authRequired, async function (req, res) {
  try {
    var booking = await Booking.findById(req.params.id);
    if (!booking) return res.status(404).json({ error: 'ไม่พบการจอง' });
    if (String(booking.user) !== req.user.id)
      return res.status(403).json({ error: 'ไม่มีสิทธิ์ยกเลิกการจองนี้' });
    if (!['pending','approved'].includes(booking.status))
      return res.status(409).json({ error: 'ไม่สามารถยกเลิกการจองที่มีสถานะ ' + booking.status + ' ได้' });

    booking.status = 'cancelled';
    await booking.save();
    res.json({ message: 'ยกเลิกการจองสำเร็จ', booking });
  } catch (err) {
    res.status(500).json({ error: 'เกิดข้อผิดพลาดภายในระบบ' });
  }
});

/* ─────────────────────────────────────────────────────
   ROUTES — BOOKINGS (Admin)
   GET  /api/admin/bookings
   PUT  /api/admin/bookings/:id/approve
   PUT  /api/admin/bookings/:id/reject
───────────────────────────────────────────────────── */

/* List all bookings (admin) */
app.get('/api/admin/bookings', adminRequired, async function (req, res) {
  try {
    var { status, room, page, limit } = req.query;
    var filter = {};
    if (status && status !== 'all') filter.status = status;
    if (room)   filter.room = room;

    var pageNum  = parseInt(page)  || 1;
    var pageSize = parseInt(limit) || 20;

    var total    = await Booking.countDocuments(filter);
    var bookings = await Booking.find(filter)
      .populate('user', 'prefix firstName lastName email department')
      .populate('room', 'name location')
      .populate('approvedBy', 'prefix firstName lastName')
      .sort({ createdAt: -1 })
      .skip((pageNum - 1) * pageSize)
      .limit(pageSize);

    res.json({ total, page: pageNum, pages: Math.ceil(total / pageSize), bookings });
  } catch (err) {
    res.status(500).json({ error: 'เกิดข้อผิดพลาดภายในระบบ' });
  }
});

/* Approve */
app.put('/api/admin/bookings/:id/approve', adminRequired, async function (req, res) {
  try {
    var booking = await Booking.findById(req.params.id);
    if (!booking) return res.status(404).json({ error: 'ไม่พบการจอง' });
    if (booking.status !== 'pending')
      return res.status(409).json({ error: 'สามารถอนุมัติได้เฉพาะการจองที่รอดำเนินการ' });

    booking.status     = 'approved';
    booking.approvedBy = req.user.id;
    booking.approvedAt = new Date();
    await booking.save();
    res.json({ message: 'อนุมัติการจองสำเร็จ', booking });
  } catch (err) {
    res.status(500).json({ error: 'เกิดข้อผิดพลาดภายในระบบ' });
  }
});

/* Reject */
app.put('/api/admin/bookings/:id/reject', adminRequired, async function (req, res) {
  try {
    var { reason } = req.body;
    if (!reason || !reason.trim())
      return res.status(400).json({ error: 'กรุณาระบุเหตุผลในการปฏิเสธ' });

    var booking = await Booking.findById(req.params.id);
    if (!booking) return res.status(404).json({ error: 'ไม่พบการจอง' });
    if (booking.status !== 'pending')
      return res.status(409).json({ error: 'สามารถปฏิเสธได้เฉพาะการจองที่รอดำเนินการ' });

    booking.status          = 'rejected';
    booking.rejectionReason = reason.trim();
    booking.approvedBy      = req.user.id;
    booking.approvedAt      = new Date();
    await booking.save();
    res.json({ message: 'ปฏิเสธการจองสำเร็จ', booking });
  } catch (err) {
    res.status(500).json({ error: 'เกิดข้อผิดพลาดภายในระบบ' });
  }
});

/* ─────────────────────────────────────────────────────
   ROUTES — USERS (Admin)
   GET  /api/admin/users
   GET  /api/admin/users/:id
   PUT  /api/admin/users/:id/approve
   PUT  /api/admin/users/:id/status
   PUT  /api/admin/users/:id/role
   DELETE /api/admin/users/:id
───────────────────────────────────────────────────── */

app.get('/api/admin/users', adminRequired, async function (req, res) {
  try {
    var { status, search, page, limit } = req.query;
    var filter = {};
    if (status && status !== 'all') filter.status = status;
    if (search) {
      var re = new RegExp(search, 'i');
      filter.$or = [{ firstName: re }, { lastName: re }, { email: re }, { department: re }];
    }

    var pageNum  = parseInt(page)  || 1;
    var pageSize = parseInt(limit) || 20;
    var total    = await User.countDocuments(filter);
    var users    = await User.find(filter)
      .sort({ createdAt: -1 })
      .skip((pageNum - 1) * pageSize)
      .limit(pageSize);

    res.json({ total, page: pageNum, pages: Math.ceil(total / pageSize), users });
  } catch (err) {
    res.status(500).json({ error: 'เกิดข้อผิดพลาดภายในระบบ' });
  }
});

app.get('/api/admin/users/:id', adminRequired, async function (req, res) {
  try {
    var user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'ไม่พบผู้ใช้' });
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: 'เกิดข้อผิดพลาดภายในระบบ' });
  }
});

/* สร้างผู้ใช้ใหม่โดยตรง (admin เท่านั้น) — ใช้ตอนแอดมินอยากเพิ่มแอดมิน/เจ้าหน้าที่คนใหม่
 * บัญชีจะ active ทันที ไม่ต้องรออนุมัติ และระบบจะสุ่มรหัสผ่านชั่วคราวให้
 * (ส่งรหัสผ่านนี้กลับไปครั้งเดียวในคำตอบ เพราะหลังจากนี้จะถูกเข้ารหัสแล้วดึงกลับไม่ได้)
 */
app.post('/api/admin/users', adminRequired, async function (req, res) {
  try {
    var { prefix, firstName, lastName, email, phone, department, position, role } = req.body;
    if (!firstName || !lastName || !email)
      return res.status(400).json({ error: 'กรุณากรอกชื่อ นามสกุล และอีเมลให้ครบ' });

    var exists = await User.findOne({ email: String(email).toLowerCase() });
    if (exists) return res.status(409).json({ error: 'อีเมลนี้ถูกใช้งานแล้ว' });

    var tempPassword = crypto.randomBytes(6).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) + 'A1';

    var user = await User.create({
      prefix: prefix || 'นาย',
      firstName: firstName,
      lastName: lastName,
      email: email,
      password: tempPassword,
      phone: phone || '',
      department: department || '',
      position: position || '',
      role: (role === 'admin') ? 'admin' : 'user',
      status: 'active'          // แอดมินสร้างเอง ถือว่าอนุมัติแล้วในตัว
    });

    res.status(201).json({
      message: 'สร้างผู้ใช้สำเร็จ',
      tempPassword: tempPassword,   // แสดงครั้งเดียว — แจ้งให้ผู้ใช้เปลี่ยนรหัสผ่านทันทีที่ login ครั้งแรก
      user: {
        id: user._id,
        fullName: user.prefix + user.firstName + ' ' + user.lastName,
        email: user.email,
        department: user.department,
        role: user.role,
        status: user.status,
        createdAt: user.createdAt
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'เกิดข้อผิดพลาดภายในระบบ' });
  }
});

/* Approve pending user */
app.put('/api/admin/users/:id/approve', adminRequired, async function (req, res) {
  try {
    var { department, role } = req.body;
    var updates = { status: 'active' };
    if (department) updates.department = department;
    if (role && ['user','admin'].includes(role)) updates.role = role;

    var user = await User.findByIdAndUpdate(req.params.id, updates, { new: true });
    if (!user) return res.status(404).json({ error: 'ไม่พบผู้ใช้' });
    if (user.status === 'pending')
      return res.status(409).json({ error: 'ผู้ใช้นี้ไม่ได้รอการอนุมัติ' });
    res.json({ message: 'อนุมัติผู้ใช้สำเร็จ', user });
  } catch (err) {
    res.status(500).json({ error: 'เกิดข้อผิดพลาดภายในระบบ' });
  }
});

/* Toggle active / inactive */
app.put('/api/admin/users/:id/status', adminRequired, async function (req, res) {
  try {
    var { status } = req.body;
    if (!['active','inactive'].includes(status))
      return res.status(400).json({ error: 'สถานะไม่ถูกต้อง' });
    if (req.params.id === req.user.id)
      return res.status(409).json({ error: 'ไม่สามารถเปลี่ยนสถานะบัญชีของตัวเองได้' });

    var user = await User.findByIdAndUpdate(req.params.id, { status }, { new: true });
    if (!user) return res.status(404).json({ error: 'ไม่พบผู้ใช้' });
    res.json({ message: 'อัปเดตสถานะผู้ใช้สำเร็จ', user });
  } catch (err) {
    res.status(500).json({ error: 'เกิดข้อผิดพลาดภายในระบบ' });
  }
});

/* Change role */
app.put('/api/admin/users/:id/role', adminRequired, async function (req, res) {
  try {
    var { role } = req.body;
    if (!['user','admin'].includes(role))
      return res.status(400).json({ error: 'บทบาทไม่ถูกต้อง' });
    if (req.params.id === req.user.id)
      return res.status(409).json({ error: 'ไม่สามารถเปลี่ยนบทบาทของตัวเองได้' });

    var user = await User.findByIdAndUpdate(req.params.id, { role }, { new: true });
    if (!user) return res.status(404).json({ error: 'ไม่พบผู้ใช้' });
    res.json({ message: 'เปลี่ยนบทบาทสำเร็จ', user });
  } catch (err) {
    res.status(500).json({ error: 'เกิดข้อผิดพลาดภายในระบบ' });
  }
});

/* Delete user */
app.delete('/api/admin/users/:id', adminRequired, async function (req, res) {
  try {
    if (req.params.id === req.user.id)
      return res.status(409).json({ error: 'ไม่สามารถลบบัญชีของตัวเองได้' });

    var user = await User.findByIdAndDelete(req.params.id);
    if (!user) return res.status(404).json({ error: 'ไม่พบผู้ใช้' });
    /* Cancel their pending bookings */
    await Booking.updateMany({ user: req.params.id, status: 'pending' }, { status: 'cancelled' });
    res.json({ message: 'ลบผู้ใช้สำเร็จ' });
  } catch (err) {
    res.status(500).json({ error: 'เกิดข้อผิดพลาดภายในระบบ' });
  }
});

/* ─────────────────────────────────────────────────────
   ROUTES — REPORTS (Admin)
   GET /api/reports/stats
   GET /api/reports/calendar?month=YYYY-MM
───────────────────────────────────────────────────── */

app.get('/api/reports/stats', adminRequired, async function (req, res) {
  try {
    /* Period: 7 | 30 | 90 | month (default: month) */
    var period = req.query.period || 'month';
    var roomId = req.query.room   || null;
    var now    = new Date();
    var since;

    if      (period === '7')  { since = new Date(now - 7  * 864e5); }
    else if (period === '30') { since = new Date(now - 30 * 864e5); }
    else if (period === '90') { since = new Date(now - 90 * 864e5); }
    else {
      /* This calendar month */
      since = new Date(now.getFullYear(), now.getMonth(), 1);
    }

    var sinceStr = since.toISOString().slice(0, 10);
    var filter   = { date: { $gte: sinceStr } };
    if (roomId) filter.room = new mongoose.Types.ObjectId(roomId);

    /* KPI counts */
    var [totalBookings, approvedBookings, pendingBookings, rejectedBookings, totalUsers, totalRooms] =
      await Promise.all([
        Booking.countDocuments(filter),
        Booking.countDocuments({ ...filter, status: 'approved' }),
        Booking.countDocuments({ ...filter, status: 'pending' }),
        Booking.countDocuments({ ...filter, status: 'rejected' }),
        User.countDocuments({ status: 'active' }),
        Room.countDocuments({ status: 'active' })
      ]);

    /* By-status breakdown */
    var byStatus = await Booking.aggregate([
      { $match: filter },
      { $group: { _id: '$status', count: { $sum: 1 } } }
    ]);

    /* Top rooms */
    var topRooms = await Booking.aggregate([
      { $match: { ...filter, status: 'approved' } },
      { $group: { _id: '$room', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 5 },
      { $lookup: { from: 'rooms', localField: '_id', foreignField: '_id', as: 'room' } },
      { $unwind: '$room' },
      { $project: { name: '$room.name', count: 1 } }
    ]);

    /* Top users */
    var topUsers = await Booking.aggregate([
      { $match: { ...filter, status: 'approved' } },
      { $group: { _id: '$user', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 5 },
      { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'user' } },
      { $unwind: '$user' },
      { $project: { name: { $concat: ['$user.firstName', ' ', '$user.lastName'] }, department: '$user.department', count: 1 } }
    ]);

    /* Daily trend (last N days) */
    var trend = await Booking.aggregate([
      { $match: { ...filter, status: { $in: ['approved','pending'] } } },
      { $group: { _id: '$date', count: { $sum: 1 } } },
      { $sort: { _id: 1 } }
    ]);

    /* Heatmap: day-of-week × hour */
    var heatmap = await Booking.aggregate([
      { $match: { ...filter, status: 'approved' } },
      { $addFields: {
          hourNum: { $toInt: { $substr: ['$startTime', 0, 2] } },
          dateObj: { $dateFromString: { dateString: '$date' } }
        }
      },
      { $addFields: { dow: { $isoDayOfWeek: '$dateObj' } } },
      { $group: { _id: { dow: '$dow', hour: '$hourNum' }, count: { $sum: 1 } } }
    ]);

    res.json({
      period, sinceStr,
      kpi: { totalBookings, approvedBookings, pendingBookings, rejectedBookings, totalUsers, totalRooms },
      byStatus,
      topRooms,
      topUsers,
      trend,
      heatmap
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'เกิดข้อผิดพลาดภายในระบบ' });
  }
});

/* Calendar view — bookings for a given month */
app.get('/api/reports/calendar', authRequired, async function (req, res) {
  try {
    var month = req.query.month || new Date().toISOString().slice(0, 7); // YYYY-MM
    var start = month + '-01';
    var d     = new Date(month + '-01');
    d.setMonth(d.getMonth() + 1);
    var end   = d.toISOString().slice(0, 10);

    var filter = { date: { $gte: start, $lt: end } };
    if (req.user.role !== 'admin') filter.user = new mongoose.Types.ObjectId(req.user.id);

    var bookings = await Booking.find(filter)
      .populate('room', 'name')
      .populate('user', 'prefix firstName lastName')
      .sort({ date: 1, startTime: 1 });

    res.json(bookings);
  } catch (err) {
    res.status(500).json({ error: 'เกิดข้อผิดพลาดภายในระบบ' });
  }
});

/* ─────────────────────────────────────────────────────
   SEED (dev only) — POST /api/seed
   Creates default admin + sample rooms
───────────────────────────────────────────────────── */
app.post('/api/seed', async function (req, res) {
    try {
      /* Admin account */
      var adminExists = await User.findOne({ email: 'admin@dld.go.th' });
      if (!adminExists) {
        await User.create({
          prefix: 'นาย', firstName: 'ผู้ดูแล', lastName: 'ระบบ',
          email: 'admin@dld.go.th', password: 'Admin@1234',
          department: 'ฝ่ายเทคโนโลยีสารสนเทศ', role: 'admin', status: 'active'
        });
      }

      /* Sample rooms */
      var roomCount = await Room.countDocuments();
      if (roomCount === 0) {
        await Room.insertMany([
          { name: 'ห้องประชุม A', location: 'ชั้น 3 อาคารหลัก', capacity: 20, status: 'active', services: ['projector','whiteboard','video_conference','aircon'] },
          { name: 'ห้องประชุม B', location: 'ชั้น 3 อาคารหลัก', capacity: 10, status: 'active', services: ['projector','whiteboard','aircon'] },
          { name: 'ห้องสัมมนา C', location: 'ชั้น 5 อาคาร B', capacity: 50, status: 'active', services: ['projector','microphone','video_conference','aircon'] },
          { name: 'ห้องประชุมผู้บริหาร', location: 'ชั้น 7 อาคาร B', capacity: 8, status: 'active', services: ['projector','video_conference','aircon'] }
        ]);
      }

      res.json({ message: 'Seed สำเร็จ', admin: 'admin@dld.go.th / Admin@1234' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

/* ─────────────────────────────────────────────────────
   CATCH-ALL — serve frontend
───────────────────────────────────────────────────── */
app.get('*', function (req, res) {
  res.sendFile(path.join(__dirname, 'index.html'));
});

/* ── Global error handler ── */
app.use(function (err, req, res, next) {
  console.error('[ERROR]', err.message);
  res.status(500).json({ error: 'เกิดข้อผิดพลาดภายในระบบ' });
});

/* ─────────────────────────────────────────────────────
   START SERVER
───────────────────────────────────────────────────── */
app.listen(PORT, function () {
  console.log('[SERVER] Running on http://localhost:' + PORT);
  console.log('[SERVER] Environment:', process.env.NODE_ENV || 'development');
  if (process.env.NODE_ENV !== 'production') {
    console.log('[SERVER] Seed endpoint: POST http://localhost:' + PORT + '/api/seed');
  }
});

module.exports = app;
