import fs from 'node:fs/promises'
import path from 'node:path'
import { db, setSetting } from './db.js'
let pending
export function createSnapshot(label='manual') {
  if (db.name === ':memory:') return Promise.resolve(null)
  if (pending) return pending
  pending = (async () => {
    const dir = process.env.NIBEX_BACKUP_DIR || path.join(path.dirname(db.name),'backups')
    await fs.mkdir(dir,{recursive:true})
    const file=path.join(dir,new Date().toISOString().replace(/[:.]/g,'-')+'-'+label+'.db')
    await db.backup(file)
    setSetting('last_backup_at',new Date().toISOString())
    setSetting('backup_error','')
    return file
  })().finally(() => {pending=null})
  return pending
}
