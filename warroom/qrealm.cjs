const D=require('better-sqlite3');
const db=new D('data/warroom.db',{readonly:true});
const t=db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r=>r.name);
const realm=t.find(n=>/enigma_secret_realm$/i.test(n));
const timer=t.find(n=>/enigma_secret_realm_timer/i.test(n));
console.log('realm='+realm+' timer='+timer+' total='+t.length);
try{
  const rows=db.prepare('SELECT id,region_id,type,roundid FROM ['+realm+'] WHERE id BETWEEN 10 AND 22 ORDER BY id').all();
  console.log('esrId region_id type roundid');
  for(const r of rows) console.log([r.id,r.region_id,r.type,r.roundid].join('  '));
}catch(e){console.log('E1',e.message);}
try{
  const cols=db.prepare('PRAGMA table_info(['+timer+'])').all().map(c=>c.name);
  console.log('timer cols: '+cols.join(','));
  const rows=db.prepare('SELECT * FROM ['+timer+'] ORDER BY id').all();
  for(const r of rows) console.log(JSON.stringify(r));
}catch(e){console.log('E2',e.message);}
