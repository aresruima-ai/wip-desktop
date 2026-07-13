require('dotenv').config({path:__dirname+'/../.env'});
const db=require('../db.js');
function pad(n){return String(n).padStart(2,'0');}
const d=new Date(); const D=d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate());
(async()=>{
  await db.connect();
  console.log('运营日',D,'  当前本地时间',pad(d.getHours())+':'+pad(d.getMinutes()));
  const codes=['ASS_Line1','ASS_Line2','ASS_Line2-1','ASS_Line3','PKG_Line1','QJG_Line1','QJG_Line2','QJG_Line3','QJG_Line4'];
  const disp={'ASS_Line1':'整机1线','ASS_Line2':'功放线','ASS_Line2-1':'功放2线','ASS_Line3':'整机3线','PKG_Line1':'包装1线','QJG_Line1':'前加工1线','QJG_Line2':'前加工3线屏组件','QJG_Line3':'前加工3线','QJG_Line4':'附件盒包装3线'};
  console.log('\n线代号            显示名            今日产量  OEE');
  for(const c of codes){
    const t=await db.queryProductionTotal(D,D,c);
    let oee=null,e=null; try{oee=await db.computeOEE(D,D,c);}catch(err){e=err.message;}
    let s='—';
    if(oee&&oee.oee!=null)s=(oee.oee*100).toFixed(1)+'%';
    else if(oee&&oee.oee===null)s='null(无数据)';
    else if(e)s='ERR:'+e.slice(0,30);
    console.log(`${c.padEnd(17)}${(disp[c]||'').padEnd(18)}${String(t).padEnd(9)}${s}  run=${oee&&oee.run_time}  out=${oee&&oee.total_output}`);
  }
  process.exit(0);
})().catch(e=>{console.error('FATAL',e);process.exit(1);});
