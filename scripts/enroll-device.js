const os = require('os');
const base = process.env.REMOTE_SUPPORT_SERVER || 'https://remotesupport-rmm.onrender.com';
const token = process.env.TECHNICIAN_TOKEN || '';
if (!token) { console.error('TECHNICIAN_TOKEN is required.'); process.exit(1); }
(async()=>{
 const hostname=os.hostname();
 const r=await fetch(base.replace(/\/$/,'')+'/api/devices/enroll',{method:'POST',headers:{'content-type':'application/json','authorization':'Bearer '+token},body:JSON.stringify({hostname})});
 if(!r.ok) throw new Error(await r.text());
 const j=await r.json();
 console.log('\nAUTHORIZED DEVICE ENROLLMENT\n');
 console.log('Device ID:',j.deviceId); console.log('Enrollment secret:',j.enrollmentSecret); console.log('Customer install page:', new URL(j.installUrl, base).toString());
 console.log('\nKeep the enrollment secret private.\n');
})().catch(e=>{console.error(e.message);process.exit(1)});
