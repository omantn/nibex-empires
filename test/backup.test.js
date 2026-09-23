import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {execFileSync} from 'node:child_process'
import Database from 'better-sqlite3'
const folder=fs.mkdtempSync(path.join(os.tmpdir(),'nibex-backup-test-'))
process.env.NIBEX_DB=path.join(folder,'game.db')
process.env.NIBEX_BACKUP_DIR=path.join(folder,'backups')
const {db,setSetting}=await import('../src/db.js')
const {createSnapshot}=await import('../src/backup.js')
test('snapshot includes WAL writes and restores in a new process',async()=>{
  try {
    setSetting('recovery_marker','committed')
    const snapshot=await createSnapshot('test')
    const copy=new Database(snapshot,{readonly:true})
    assert.equal(copy.prepare("SELECT value FROM settings WHERE key='recovery_marker'").get().value,'committed')
    assert.equal(copy.pragma('integrity_check',{simple:true}),'ok')
    copy.close()
    setSetting('recovery_marker','later')
    db.close()
    const result=execFileSync(process.execPath,['--input-type=module','-e',"const {getSetting,db}=await import('./src/db.js');console.log(getSetting('recovery_marker'));db.close()"],{cwd:new URL('..',import.meta.url),env:{...process.env,NIBEX_DB:snapshot},encoding:'utf8'})
    assert.equal(result.trim(),'committed')
  } finally {
    if(db.open)db.close()
    // folder is the absolute, uniquely created OS temporary directory above.
    fs.rmSync(folder,{recursive:true,force:true})
  }
})
