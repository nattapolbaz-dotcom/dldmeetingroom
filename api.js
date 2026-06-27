/**
 * api.js — ไฟล์กลางสำหรับจัดการ API + Authentication
 * ================================================================
 * ทุกหน้าในระบบจะ include ไฟล์นี้ด้วย <script src="api.js">
 *
 * หน้าที่ของไฟล์นี้:
 *   1. เก็บ / อ่าน / ลบ Token และข้อมูล User ใน localStorage
 *   2. ห่อ fetch() ให้แนบ Token ไปโดยอัตโนมัติทุก request
 *   3. ตรวจสอบสิทธิ์ก่อนโหลดหน้า (Auth Guard)
 *   4. Helper functions ต่างๆ เช่น logout, getCurrentUser
 */

(function () {
  'use strict';

  /* ================================================================
     SECTION 1 — CONSTANTS
     ค่าคงที่ที่ใช้ทั้งระบบ เปลี่ยนที่เดียว ใช้ทุกที่
  ================================================================ */

  /** URL หลักของ API — เมื่อ deploy จริงให้เปลี่ยนเป็น domain จริง */
  var API_BASE = '/api';

  /**
   * KEY ที่ใช้เก็บข้อมูลใน localStorage
   * เหมือนชื่อลิ้นชัก — เราเปิดลิ้นชักนี้เพื่อเอาของออกมาใช้
   */
  var STORAGE_KEY_TOKEN = 'dld_token';   // เก็บ JWT token
  var STORAGE_KEY_USER  = 'dld_user';    // เก็บข้อมูล user (JSON)

  /* ================================================================
     SECTION 2 — TOKEN MANAGEMENT
     ฟังก์ชันจัดการ Token ใน localStorage
  ================================================================ */

  /**
   * getToken() — ดึง token ออกจาก localStorage
   *
   * ตัวอย่างการทำงาน:
   *   localStorage มี { dld_token: "eyJhbGci..." }
   *   getToken() คืนค่า "eyJhbGci..."
   */
  function getToken() {
    return localStorage.getItem(STORAGE_KEY_TOKEN);
  }

  /**
   * setToken(token) — บันทึก token ลง localStorage
   * เรียกใช้ตอนที่ login สำเร็จ
   */
  function setToken(token) {
    localStorage.setItem(STORAGE_KEY_TOKEN, token);
  }

  /**
   * removeToken() — ลบ token ออกจาก localStorage
   * เรียกใช้ตอน logout
   */
  function removeToken() {
    localStorage.removeItem(STORAGE_KEY_TOKEN);
  }

  /* ================================================================
     SECTION 3 — USER DATA MANAGEMENT
     ฟังก์ชันจัดการข้อมูล User ใน localStorage
  ================================================================ */

  /**
   * getCurrentUser() — ดึงข้อมูล user ที่ login อยู่
   *
   * ทำงานอย่างไร:
   *   localStorage เก็บ JSON string ไว้ เช่น
   *   '{"id":"123","fullName":"นายสมชาย ใจดี","role":"user"}'
   *   เราต้อง JSON.parse() แปลงกลับเป็น Object ก่อนใช้
   *
   * คืนค่า: Object หรือ null ถ้าไม่มีข้อมูล
   */
  function getCurrentUser() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY_USER);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      // ถ้า JSON เสียหาย ให้ return null แทน crash
      return null;
    }
  }

  /**
   * setCurrentUser(user) — บันทึกข้อมูล user ลง localStorage
   * รับ Object แล้วแปลงเป็น JSON string ก่อนเก็บ
   */
  function setCurrentUser(user) {
    localStorage.setItem(STORAGE_KEY_USER, JSON.stringify(user));
  }

  /**
   * removeCurrentUser() — ลบข้อมูล user ออกจาก localStorage
   */
  function removeCurrentUser() {
    localStorage.removeItem(STORAGE_KEY_USER);
  }

  /* ================================================================
     SECTION 4 — authFetch() — ตัวเอกของไฟล์นี้
     ================================================================

     ปัญหาที่แก้:
       ปกติถ้าจะเรียก API ที่ต้องการ Token ต้องเขียนซ้ำทุกครั้ง:
         fetch('/api/bookings', {
           headers: { 'Authorization': 'Bearer ' + token }
         })

       authFetch() ห่อ fetch() ไว้ ใส่ Token ให้อัตโนมัติ
       เราแค่เรียก authFetch('/api/bookings') สั้นๆ

     การทำงาน:
       1. ดึง token จาก localStorage
       2. ใส่ Authorization header โดยอัตโนมัติ
       3. ถ้า server ตอบกลับ 401 (token หมดอายุ) → logout ทันที
       4. คืนค่า response เหมือน fetch() ปกติ

  ================================================================ */

  /**
   * authFetch(url, options) — fetch ที่แนบ Token อัตโนมัติ
   *
   * @param {string} url     - path เช่น '/api/bookings' หรือ full URL
   * @param {object} options - เหมือน fetch options: { method, body, headers }
   * @returns {Promise<Response>}
   *
   * ตัวอย่างการใช้งาน:
   *   // GET
   *   var res = await authFetch('/api/bookings');
   *   var data = await res.json();
   *
   *   // POST with body
   *   var res = await authFetch('/api/bookings', {
   *     method: 'POST',
   *     body: JSON.stringify({ title: 'ประชุมทีม', date: '2024-03-01' })
   *   });
   */
  async function authFetch(url, options) {
    options = options || {};

    var token = getToken();

    // สร้าง headers ใหม่ที่รวม Authorization เข้าไปด้วย
    var headers = Object.assign(
      { 'Content-Type': 'application/json' },  // บอก server ว่าส่ง JSON
      options.headers || {}                     // headers เพิ่มเติมถ้ามี
    );

    // ถ้ามี token ให้แนบไปใน Authorization header
    // รูปแบบ: "Bearer eyJhbGci..." (มาตรฐาน JWT)
    if (token) {
      headers['Authorization'] = 'Bearer ' + token;
    }

    // เรียก fetch จริง พร้อม headers ที่เพิ่ม token แล้ว
    var response = await fetch(API_BASE + url, Object.assign({}, options, { headers: headers }));

    // ถ้า server ตอบ 401 = token หมดอายุหรือไม่ถูกต้อง
    // ให้ logout และ redirect ไป login ทันที
    if (response.status === 401) {
      logout(false); // false = ไม่แสดง toast
      return response;
    }

    return response;
  }

  /* ================================================================
     SECTION 5 — AUTH GUARD (ยาม)
     ================================================================

     checkAuth() ทำหน้าที่เป็น "ยาม" ของทุกหน้า
     เรียกตอนโหลดหน้าเสมอ — ถ้าไม่มี token ไล่ออก

     รูปแบบการใช้งานใน HTML:
       <script src="api.js"></script>
       <script>
         checkAuth();           // ตรวจสอบ — ถ้าไม่มี token redirect ทันที
         populateUserUI();      // เอาชื่อ user ไปใส่ใน UI
       </script>

  ================================================================ */

  /**
   * checkAuth(requireAdmin) — ตรวจสอบว่า user login อยู่หรือเปล่า
   *
   * @param {boolean} requireAdmin - true = หน้านี้ต้องการสิทธิ์ admin เท่านั้น
   *
   * ถ้าไม่มี token     → redirect ไป login.html
   * ถ้าไม่ใช่ admin    → redirect ไป dashboard.html (ถ้า requireAdmin = true)
   * ถ้าผ่าน           → return user object
   */
  function checkAuth(requireAdmin) {
    var token = getToken();
    var user  = getCurrentUser();

    if (!token || !user) {
      // ไม่มี token = ยังไม่ได้ login
      window.location.replace('login.html');
      return null;
    }

    if (requireAdmin && user.role !== 'admin') {
      // หน้านี้ต้องการ admin แต่ user ไม่ใช่
      window.location.replace('dashboard.html');
      return null;
    }

    return user;
  }

  /**
   * populateUserUI() — เอาชื่อ user จริงไปใส่ใน sidebar และ navbar
   *
   * หลังจาก checkAuth() ผ่านแล้ว เรียกฟังก์ชันนี้เพื่อ
   * อัปเดต UI ให้แสดงชื่อ-แผนก-อักษรย่อของ user จริง
   */
  function populateUserUI() {
    var user = getCurrentUser();
    if (!user) return;

    var initial  = (user.firstName || user.fullName || 'U').charAt(0);
    var fullName = user.fullName || (user.firstName + ' ' + user.lastName);
    var dept     = user.department || '';
    var role     = user.role === 'admin' ? 'ผู้ดูแลระบบ' : 'เจ้าหน้าที่ทั่วไป';

    // อักษรย่อ avatar
    document.querySelectorAll('.user-av, .navbar-avatar').forEach(function (el) {
      el.textContent = initial;
    });

    // ชื่อใน sidebar footer
    var fnEl = document.querySelector('.user-fn');
    if (fnEl) fnEl.textContent = fullName;

    var frEl = document.querySelector('.user-fr');
    if (frEl) frEl.textContent = role;
  }

  /* ================================================================
     SECTION 6 — LOGOUT
  ================================================================ */

  /**
   * logout(showMessage) — ออกจากระบบ
   *
   * @param {boolean} showMessage - true = แสดงข้อความก่อน redirect
   *
   * ทำสิ่งเหล่านี้:
   *   1. ลบ token ออกจาก localStorage
   *   2. ลบข้อมูล user ออกจาก localStorage
   *   3. Redirect ไป login.html
   */
  function logout(showMessage) {
    removeToken();
    removeCurrentUser();
    if (showMessage !== false) {
      // ถ้าหน้าปัจจุบันมี showToast ให้ใช้ ถ้าไม่มีก็ไม่เป็นไร
      if (typeof window.showToast === 'function') {
        window.showToast('ออกจากระบบแล้ว', 'info');
        setTimeout(function () { window.location.replace('login.html'); }, 800);
        return;
      }
    }
    window.location.replace('login.html');
  }

  /* ================================================================
     SECTION 7 — HELPER UTILITIES
  ================================================================ */

  /**
   * isLoggedIn() — เช็คอย่างเร็วว่า login อยู่หรือเปล่า
   * คืน true/false
   */
  function isLoggedIn() {
    return !!(getToken() && getCurrentUser());
  }

  /**
   * apiGet(path) — GET shorthand
   * ตัวอย่าง: var rooms = await apiGet('/rooms');
   */
  async function apiGet(path) {
    var res = await authFetch(path);
    if (!res.ok) {
      var err = await res.json().catch(function () { return {}; });
      throw new Error(err.error || 'เกิดข้อผิดพลาด');
    }
    return res.json();
  }

  /**
   * apiPost(path, body) — POST shorthand
   * ตัวอย่าง: var booking = await apiPost('/bookings', { title: '...' });
   */
  async function apiPost(path, body) {
    var res = await authFetch(path, {
      method: 'POST',
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      var err = await res.json().catch(function () { return {}; });
      throw new Error(err.error || 'เกิดข้อผิดพลาด');
    }
    return res.json();
  }

  /**
   * apiPut(path, body) — PUT shorthand
   * ตัวอย่าง: await apiPut('/bookings/123/cancel');
   */
  async function apiPut(path, body) {
    var res = await authFetch(path, {
      method: 'PUT',
      body: JSON.stringify(body || {})
    });
    if (!res.ok) {
      var err = await res.json().catch(function () { return {}; });
      throw new Error(err.error || 'เกิดข้อผิดพลาด');
    }
    return res.json();
  }

  /**
   * apiDelete(path) — DELETE shorthand
   */
  async function apiDelete(path) {
    var res = await authFetch(path, { method: 'DELETE' });
    if (!res.ok) {
      var err = await res.json().catch(function () { return {}; });
      throw new Error(err.error || 'เกิดข้อผิดพลาด');
    }
    return res.json();
  }

  /* ================================================================
     SECTION 8 — EXPOSE TO GLOBAL SCOPE
     ================================================================

     เปิดให้ฟังก์ชันเหล่านี้เรียกใช้ได้จากไฟล์ HTML อื่นๆ
     โดยแนบไว้ใน window object (global)

     ตัวอย่าง: หน้า login.html เรียก window.setToken(token) ได้เลย
               หรือเขียนสั้นๆ ว่า setToken(token)

  ================================================================ */
  window.DLD = {
    // Token
    getToken:        getToken,
    setToken:        setToken,
    removeToken:     removeToken,
    // User
    getCurrentUser:  getCurrentUser,
    setCurrentUser:  setCurrentUser,
    removeCurrentUser: removeCurrentUser,
    // Auth
    checkAuth:       checkAuth,
    populateUserUI:  populateUserUI,
    logout:          logout,
    isLoggedIn:      isLoggedIn,
    // Fetch helpers
    authFetch:       authFetch,
    apiGet:          apiGet,
    apiPost:         apiPost,
    apiPut:          apiPut,
    apiDelete:       apiDelete
  };

  // Shorthand — เรียก DLD.checkAuth() หรือ checkAuth() ก็ได้
  window.checkAuth      = checkAuth;
  window.populateUserUI = populateUserUI;
  window.logout         = function () { logout(true); };
  window.apiGet         = apiGet;
  window.apiPost        = apiPost;
  window.apiPut         = apiPut;
  window.apiDelete      = apiDelete;

}());
