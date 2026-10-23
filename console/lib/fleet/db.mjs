export const statement=(db,sql,...args)=>db.prepare(sql).bind(...args.map(x=>x===undefined?null:x));
export const first=(db,sql,...args)=>statement(db,sql,...args).first();
export const all=async(db,sql,...args)=>(await statement(db,sql,...args).all()).results||[];
export const run=(db,sql,...args)=>statement(db,sql,...args).run();
export const batch=(db,items)=>db.batch(items.map(([sql,...args])=>statement(db,sql,...args)));
