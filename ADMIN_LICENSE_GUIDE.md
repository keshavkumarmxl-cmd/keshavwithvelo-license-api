# Keshav With Velo — License Admin Guide

## Admin panel open karna

Production URL:

```text
https://keshavwithvelo-license-api.onrender.com/admin
```

Login ke liye `ADMIN_EMAIL` aur `ADMIN_PASSWORD` use karein. Credentials kisi customer ke saath share na karein.

Login ke baad dashboard automatically recent licenses dikhata hai. Search box me customer email ya license key dalke specific record dhoondh sakte hain.

## License record me kya dikhta hai

- `key`: customer ki activation key
- `email`: purchase/registered email
- `machine_id`: key jis PC par activate hui hai; empty ho to key abhi activate nahi hui
- `status`: active license usable hai; inactive/revoked license usable nahi honi chahiye

## Common support actions

### 1. Customer ko key email nahi mili

1. Pehle payment Razorpay Dashboard me verify karein.
2. Admin panel me customer email search karein.
3. Agar existing key milti hai, us key ko search box me paste karein.
4. **Resend key** click karein.

Nayi key create na karein agar customer ke paas already key record maujood hai.

### 2. Payment verified hai, lekin key record nahi hai

1. Razorpay payment ID, amount aur email confirm karein.
2. **Create + send** click karein.
3. Customer ka correct email enter karein.
4. Panel key create karke email bhejega.

### 3. “This license is already activated on another device”

Pehle verify karein ki customer ne genuinely PC change/reinstall kiya hai. Phir:

1. Customer ki key search box me enter karein.
2. **Reset device** click karein.
3. Customer ko same key aur registered email se activation dobara karne ko bolein.

Reset device se key delete nahi hoti. Sirf old PC binding remove hoti hai.

### 4. Existing user ki key replace karni hai

1. Existing key search box me enter karein.
2. **Change key + send** click karein.
3. Confirm karein.

Old key immediately invalid ho jayegi. New key same registered email par send hogi. Existing device binding/status preserve hota hai.

## Safety rules

- License key, customer email, database details, Razorpay secrets, Resend API key, aur admin password public chat/screenshot me share na karein.
- Payment verify kiye bina key create na karein.
- “Reset device” customer request aur identity/payment verify karne ke baad hi use karein.
- Existing customer ke liye pehle **Search**, phir **Resend key** use karein; duplicate keys avoid karein.
- Credentials rotate hon to Render Environment me update karein aur team ko new credentials secure channel me dein.

## Escalation checklist

In cases me owner/developer ko inform karein:

- Razorpay payment successful but record/key nahi milti
- Resend delivery fail/repeated bounce
- Same user repeatedly device reset mang raha hai
- Key unauthorized person ke paas hone ka doubt hai
- Admin login/production backend unavailable hai
