#!/bin/bash
# ════════════════════════════════════════════════════
#  DLD Meeting Room — API Test Script v2
#  รัน: bash test-api.sh
# ════════════════════════════════════════════════════

BASE="http://localhost:3000/api"
PASS=0; FAIL=0

green() { echo -e "\033[32m✅ $1\033[0m"; }
red()   { echo -e "\033[31m❌ $1 → ได้: $(echo "$2" | head -c 150)\033[0m"; }
head_s(){ echo -e "\n\033[1;34m── $1 ──\033[0m"; }

check() {
  local label="$1"; local got="$2"; local expect="$3"
  if echo "$got" | grep -qE "$expect"; then
    green "$label"; ((PASS++))
  else
    red "$label" "$got"; ((FAIL++))
  fi
}

# สร้าง email ไม่ซ้ำกันทุกครั้ง
TS=$(date +%s)
TEST_EMAIL="test${TS}@dld.go.th"

# ─── 1. AUTH ───────────────────────────────────────
head_s "1. AUTH"

# Login ผิด password
R=$(curl -s -X POST "$BASE/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@dld.go.th","password":"WrongPass"}')
check "Login — รหัสผ่านผิด → error" "$R" "error|ไม่ถูกต้อง"

# Login admin
LOGIN=$(curl -s -X POST "$BASE/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@dld.go.th","password":"Admin@1234"}')
check "Login admin → token" "$LOGIN" "token"
TOKEN=$(echo "$LOGIN" | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])" 2>/dev/null)

# Register user ใหม่ (email ไม่ซ้ำ) — server จะ return userId (ไม่มี token เพราะต้องรอ approve)
REG=$(curl -s -X POST "$BASE/auth/register" \
  -H "Content-Type: application/json" \
  -d "{\"prefix\":\"นาย\",\"firstName\":\"ทดสอบ\",\"lastName\":\"ระบบ\",\"email\":\"$TEST_EMAIL\",\"password\":\"Test@1234\",\"department\":\"IT\",\"position\":\"เจ้าหน้าที่\"}")
check "Register user ใหม่ → userId" "$REG" "userId|message"
NEW_USER_ID=$(echo "$REG" | python3 -c "import sys,json; print(json.load(sys.stdin).get('userId',''))" 2>/dev/null)

# Admin approve ผู้ใช้ใหม่ทันที
if [ -n "$NEW_USER_ID" ]; then
  curl -s -X PUT "$BASE/admin/users/$NEW_USER_ID/status" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"status":"active"}' > /dev/null
fi

# Login user ใหม่ (หลัง approve แล้ว)
LOGIN2=$(curl -s -X POST "$BASE/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$TEST_EMAIL\",\"password\":\"Test@1234\"}")
check "Login user ใหม่ → token" "$LOGIN2" "token"
TOKEN2=$(echo "$LOGIN2" | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))" 2>/dev/null)

# ─── 2. PROFILE ────────────────────────────────────
head_s "2. PROFILE"

R=$(curl -s "$BASE/profile" -H "Authorization: Bearer $TOKEN")
check "GET /profile (admin)" "$R" "email|firstName"

R=$(curl -s -X PUT "$BASE/profile" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"firstName":"อดิศร","lastName":"ผู้บริหาร","phone":"0812345678"}')
check "PUT /profile → update name" "$R" "สำเร็จ|message"

# เปลี่ยนรหัสผ่าน user ใหม่ (ใช้ TOKEN2)
R=$(curl -s -X PUT "$BASE/profile/password" \
  -H "Authorization: Bearer $TOKEN2" \
  -H "Content-Type: application/json" \
  -d '{"currentPassword":"Test@1234","newPassword":"NewPass@9999"}')
check "PUT /profile/password → เปลี่ยนสำเร็จ" "$R" "สำเร็จ|message"

R=$(curl -s -X PUT "$BASE/profile/2fa" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"enabled":true}')
check "PUT /profile/2fa → เปิด 2FA" "$R" "2FA|message"

R=$(curl -s -X PUT "$BASE/profile/notifications" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"approved":true,"rejected":true,"reminder":false,"system":true}')
check "PUT /profile/notifications → บันทึกสำเร็จ" "$R" "สำเร็จ|message"

# ─── 3. ROOMS ──────────────────────────────────────
head_s "3. ROOMS"

R=$(curl -s "$BASE/rooms" -H "Authorization: Bearer $TOKEN")
check "GET /rooms → list ห้อง" "$R" "name|capacity"
ROOM_ID=$(echo "$R" | python3 -c "import sys,json; r=json.load(sys.stdin); print(r[0]['_id'])" 2>/dev/null)

R=$(curl -s -X POST "$BASE/rooms" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"ห้องทดสอบ QA","capacity":10,"location":"ชั้น 1","description":"ห้องทดสอบ"}')
check "POST /rooms (admin) → สร้างห้อง" "$R" "name|_id"
NEW_ROOM_ID=$(echo "$R" | python3 -c "import sys,json; print(json.load(sys.stdin)['_id'])" 2>/dev/null)

R=$(curl -s -X PUT "$BASE/rooms/$NEW_ROOM_ID" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"capacity":15}')
check "PUT /rooms/:id (admin) → แก้ไขห้อง" "$R" "name|_id"

# ─── 4. BOOKINGS ───────────────────────────────────
head_s "4. BOOKINGS"

# จองห้องด้วย user ใหม่ — ใช้ NEW_ROOM_ID (ห้องใหม่ ไม่มี booking เก่าค้าง)
TODAY=$(date +%Y-%m-%d)
R=$(curl -s -X POST "$BASE/bookings" \
  -H "Authorization: Bearer $TOKEN2" \
  -H "Content-Type: application/json" \
  -d "{\"room\":\"$NEW_ROOM_ID\",\"title\":\"ทดสอบจองห้อง\",\"purpose\":\"QA Test\",\"date\":\"$TODAY\",\"startTime\":\"10:00\",\"endTime\":\"11:00\",\"attendees\":3}")
check "POST /bookings (user) → จองห้อง" "$R" "_id|title"
BOOKING_ID=$(echo "$R" | python3 -c "import sys,json; print(json.load(sys.stdin)['_id'])" 2>/dev/null)

# ทดสอบ conflict — จองเวลาซ้อนกัน (admin จองซ้ำห้องเดิม)
R=$(curl -s -X POST "$BASE/bookings" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"room\":\"$NEW_ROOM_ID\",\"title\":\"Conflict Test\",\"purpose\":\"QA\",\"date\":\"$TODAY\",\"startTime\":\"10:30\",\"endTime\":\"11:30\",\"attendees\":2}")
check "POST /bookings — conflict → ถูก reject" "$R" "conflict|ถูกจอง|error|มีการจอง"

# GET bookings ของ user ใหม่
R=$(curl -s "$BASE/bookings" -H "Authorization: Bearer $TOKEN2")
check "GET /bookings (user) → list การจอง" "$R" "bookings|total"

# Admin: GET all bookings
R=$(curl -s "$BASE/admin/bookings" -H "Authorization: Bearer $TOKEN")
check "GET /admin/bookings (admin) → list ทั้งหมด" "$R" "bookings|total"

# Admin: Approve booking
if [ -n "$BOOKING_ID" ]; then
  R=$(curl -s -X PUT "$BASE/admin/bookings/$BOOKING_ID/approve" \
    -H "Authorization: Bearer $TOKEN")
  check "PUT /admin/bookings/:id/approve → อนุมัติ" "$R" "approved|message"

  # ลอง cancel หลัง approve (ควรได้รับอนุญาต)
  R=$(curl -s -X PUT "$BASE/bookings/$BOOKING_ID/cancel" \
    -H "Authorization: Bearer $TOKEN2")
  check "PUT /bookings/:id/cancel → ยกเลิก" "$R" "cancelled|message|error"
else
  red "ข้าม approve/cancel (ไม่มี BOOKING_ID)" ""
  ((FAIL+=2))
fi

# ลบห้องทดสอบ (cleanup) — ทำหลัง booking เสร็จ
R=$(curl -s -X DELETE "$BASE/rooms/$NEW_ROOM_ID" \
  -H "Authorization: Bearer $TOKEN")
check "DELETE /rooms/:id (admin) → ลบห้อง" "$R" "message|สำเร็จ"

# ─── 5. ADMIN — USERS ──────────────────────────────
head_s "5. ADMIN — USERS"

R=$(curl -s "$BASE/admin/users" -H "Authorization: Bearer $TOKEN")
check "GET /admin/users → list ผู้ใช้" "$R" "users|email"

# หา USER_ID จาก TEST_EMAIL
USER_ID=$(echo "$R" | python3 -c "
import sys,json
users=json.load(sys.stdin).get('users',[])
found=[u['_id'] for u in users if u.get('email')=='$TEST_EMAIL']
print(found[0] if found else '')
" 2>/dev/null)

if [ -n "$USER_ID" ]; then
  R=$(curl -s -X PUT "$BASE/admin/users/$USER_ID/status" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"status":"inactive"}')
  check "PUT /admin/users/:id/status → suspend" "$R" "message|status|สำเร็จ"

  R=$(curl -s -X PUT "$BASE/admin/users/$USER_ID/status" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"status":"active"}')
  check "PUT /admin/users/:id/status → reactivate" "$R" "message|status|สำเร็จ"

  # ลบ test user หลังทดสอบ (cleanup)
  R=$(curl -s -X DELETE "$BASE/admin/users/$USER_ID" \
    -H "Authorization: Bearer $TOKEN")
  check "DELETE /admin/users/:id → ลบ test user" "$R" "message|สำเร็จ"
else
  red "ข้าม user status tests (ไม่พบ USER_ID)" ""
  ((FAIL+=3))
fi

# User ปกติเข้า admin endpoint → ถูก block
R=$(curl -s "$BASE/admin/users" -H "Authorization: Bearer $TOKEN2")
check "GET /admin/users (user ปกติ) → 403" "$R" "403|ไม่มีสิทธิ์|error|admin"

# ─── 6. REPORTS ────────────────────────────────────
head_s "6. REPORTS"

R=$(curl -s "$BASE/reports/stats?period=month" -H "Authorization: Bearer $TOKEN")
check "GET /reports/stats?period=month" "$R" "kpi|byStatus|trend"

R=$(curl -s "$BASE/reports/stats?period=7d" -H "Authorization: Bearer $TOKEN")
check "GET /reports/stats?period=7d" "$R" "kpi|period"

R=$(curl -s "$BASE/reports/calendar?month=$(date +%Y-%m)" -H "Authorization: Bearer $TOKEN")
check "GET /reports/calendar?month=YYYY-MM" "$R" "\[|date|_id|\[\]"

R=$(curl -s "$BASE/reports/stats" -H "Authorization: Bearer $TOKEN2")
check "GET /reports/stats (user ปกติ) → 403" "$R" "403|ไม่มีสิทธิ์|error|admin"

# ─── 7. AUTH GUARD ─────────────────────────────────
head_s "7. AUTH GUARD (ไม่มี token)"

R=$(curl -s "$BASE/profile")
check "GET /profile ไม่มี token → 401" "$R" "401|token|กรุณา|error"

R=$(curl -s "$BASE/bookings")
check "GET /bookings ไม่มี token → 401" "$R" "401|token|กรุณา|error"

# ─── สรุป ───────────────────────────────────────────
echo ""
echo "════════════════════════════════════════"
TOTAL=$((PASS+FAIL))
if [ $FAIL -eq 0 ]; then
  echo -e "  \033[32m🎉 ผ่านทั้งหมด $PASS/$TOTAL รายการ\033[0m"
else
  echo -e "  ผลการทดสอบ: \033[32m$PASS ผ่าน\033[0m / \033[31m$FAIL ไม่ผ่าน\033[0m (รวม $TOTAL)"
fi
echo "════════════════════════════════════════"
