// Phase 2B: explicit policy administration. These tables are not yet used by all legacy readers.
// DO NOT treat a ban written here as enforced until Phase 2C is completed.
const express = require('express');
const { query, pool } = require('../db');
const auth = require('../middleware/auth');
const { can } = require('../permissions');
const { positiveId } = require('../channelAccessPhase2');
const { reconcileChannelRoom } = require('../channelRoomReconcile');
const { refuseOwnerSelfGrant } = require('../ownerChannelAccess');
const { idList, membershipInput, inviteInput, banInput } = require('../channelPolicyValidation');
const router = express.Router();
router.use(auth);
const fail = (status, message) => Object.assign(new Error(message), { status });
const respondError = (res, err) => res.status(err.status || 500).json({ error: err.status ? err.message : 'Server error' });
async function audit(client, channelId, actor, target, action, details) {
  await client.query('INSERT INTO moderation_audit_log (channel_id, actor_id, target_user_id, action, details) VALUES ($1, $2, $3, $4, $5)',
    [channelId, actor, target, action, JSON.stringify(details)]);
}
async function allowedManager(channelId, actor) {
  const row = (await query('SELECT id, created_by, is_personal FROM channels WHERE id = $1', [channelId])).rows[0];
  if (!row) throw fail(404, 'Channel not found');
  if (row.is_personal) throw fail(409, 'Personal channels cannot use department policies');
  const granted = Number(row.created_by) === actor || await can(query, actor, 'manage_channels') ||
    (await query("SELECT 1 FROM channel_members WHERE channel_id = $1 AND user_id = $2 AND role = 'moderator'", [channelId, actor])).rows.length > 0;
  if (!granted) throw fail(403, 'Channel management permission required');
}
async function refreshChannelSockets(req, channelId) {
  if (!req.io) return;
  try { await reconcileChannelRoom(req.io, query, channelId); }
  catch (error) { console.error('Channel access socket reconciliation failed:', error); }
}
async function verifyEmployees(client, userIds) {
  if (!userIds.length) return;
  const rows = (await client.query("SELECT id FROM users WHERE id = ANY($1::integer[]) AND account_type = 'member' AND deactivated_at IS NULL", [userIds])).rows;
  if (rows.length !== userIds.length) throw fail(400, 'All recipients must be active members');
}
async function transaction(fn) {
  const client = await pool.connect();
  try { await client.query('BEGIN'); const value = await fn(client); await client.query('COMMIT'); return value; }
  catch (err) { await client.query('ROLLBACK'); throw err; }
  finally { client.release(); }
}
router.get('/:channelId/access-policy', async (req, res) => {
  try {
    const channelId = positiveId(req.params.channelId); if (!channelId) throw fail(400, 'Invalid channel ID');
    await allowedManager(channelId, req.user.userId);
    const [departments, invites, bans] = await Promise.all([
      query('SELECT department_id FROM channel_department_grants WHERE channel_id = $1 ORDER BY department_id', [channelId]),
      query('SELECT user_id, expires_at FROM channel_direct_grants WHERE channel_id = $1 ORDER BY user_id', [channelId]),
      query('SELECT user_id, reason, created_at FROM channel_bans WHERE channel_id = $1 ORDER BY user_id', [channelId])
    ]);
    res.json({ enforced: false, departmentIds: departments.rows.map(r => r.department_id), invitations: invites.rows, bans: bans.rows });
  } catch (err) { respondError(res, err); }
});
router.put('/:channelId/access-policy/departments', async (req, res) => {
  try {
    const channelId = positiveId(req.params.channelId); if (!channelId) throw fail(400, 'Invalid channel ID');
    const ids = idList(req.body?.departmentIds);
    await allowedManager(channelId, req.user.userId);
    if (req.body?.confirmHistoryExposure !== true) throw fail(400, 'Confirm that new members receive full retained history');
    const already = (await query('SELECT department_id FROM channel_department_grants WHERE channel_id = $1', [channelId])).rows.map((r) => Number(r.department_id));
    await refuseOwnerSelfGrant(query, req.user.userId, channelId, { departmentIds: ids.filter((id) => !already.includes(Number(id))) });
    await transaction(async client => {
      if (ids.length) {
        const found = (await client.query('SELECT id FROM departments WHERE id = ANY($1::integer[])', [ids])).rows;
        if (found.length !== ids.length) throw fail(400, 'Unknown department');
      }
      await client.query('DELETE FROM channel_department_grants WHERE channel_id = $1', [channelId]);
      for (const id of ids) await client.query('INSERT INTO channel_department_grants(channel_id, department_id, granted_by) VALUES ($1, $2, $3)', [channelId, id, req.user.userId]);
      await audit(client, channelId, req.user.userId, null, 'channel_department_grants_updated', { departmentIds: ids });
    });
    await refreshChannelSockets(req, channelId);
    res.json({ enforced: false, departmentIds: ids });
  } catch (err) { respondError(res, err); }
});
router.put('/:channelId/access-policy/invitation', async (req, res) => {
  try {
    const channelId = positiveId(req.params.channelId); if (!channelId) throw fail(400, 'Invalid channel ID');
    const input = inviteInput(req.body);
    await allowedManager(channelId, req.user.userId);
    if (req.body?.confirmHistoryExposure !== true) throw fail(400, 'Confirm full history exposure');
    await refuseOwnerSelfGrant(query, req.user.userId, channelId, { userIds: [input.userId] });
    await transaction(async client => {
      await verifyEmployees(client, [input.userId]);
      await client.query(`INSERT INTO channel_direct_grants(channel_id,user_id,granted_by,expires_at) VALUES($1,$2,$3,$4)
        ON CONFLICT(channel_id,user_id) DO UPDATE SET expires_at = EXCLUDED.expires_at, granted_by = EXCLUDED.granted_by`,
      [channelId,input.userId,req.user.userId,input.expiresAt]);
      await audit(client,channelId,req.user.userId,input.userId,'channel_direct_invited',{expiresAt:input.expiresAt});
    });
    await refreshChannelSockets(req, channelId);
    res.json({ enforced:false, ...input });
  } catch(err) { respondError(res,err); }
});
router.delete('/:channelId/access-policy/invitation/:userId', async (req,res) => {
  try {
    const channelId=positiveId(req.params.channelId), userId=positiveId(req.params.userId);
    if(!channelId || !userId) throw fail(400,'Invalid identifiers');
    await allowedManager(channelId,req.user.userId);
    await transaction(async client => {
      await client.query('DELETE FROM channel_direct_grants WHERE channel_id=$1 AND user_id=$2',[channelId,userId]);
      await audit(client,channelId,req.user.userId,userId,'channel_direct_revoked',{});
    });
    await refreshChannelSockets(req, channelId);
    res.json({enforced:false,revoked:true});
  } catch(err) {respondError(res,err);}
});
router.put('/:channelId/access-policy/ban', async (req,res) => {
  try {
    const channelId=positiveId(req.params.channelId); if(!channelId) throw fail(400,'Invalid channel ID');
    const input=banInput(req.body);
    await allowedManager(channelId,req.user.userId);
    await transaction(async client => {
      await verifyEmployees(client,[input.userId]);
      const manager = await client.query("SELECT 1 FROM channel_members WHERE channel_id = $1 AND user_id = $2 AND role = 'moderator'", [channelId, input.userId]);
      if (manager.rows.length) throw fail(409, 'Remove manager authority under the succession policy before banning');
      await client.query(`INSERT INTO channel_bans(channel_id,user_id,banned_by,reason) VALUES($1,$2,$3,$4)
       ON CONFLICT(channel_id,user_id) DO UPDATE SET banned_by=EXCLUDED.banned_by,reason=EXCLUDED.reason,created_at=NOW()`,
       [channelId,input.userId,req.user.userId,input.reason]);
      await audit(client,channelId,req.user.userId,input.userId,'channel_banned',{reason:input.reason});
    });
    await refreshChannelSockets(req, channelId);
    res.json({enforced:false,banned:true});
  } catch(err) {respondError(res,err);}
});
router.delete('/:channelId/access-policy/ban/:userId', async (req,res) => {
  try {
    const channelId=positiveId(req.params.channelId),userId=positiveId(req.params.userId);
    if(!channelId || !userId) throw fail(400,'Invalid identifiers');
    await allowedManager(channelId,req.user.userId);
    await transaction(async client => {
      await client.query('DELETE FROM channel_bans WHERE channel_id=$1 AND user_id=$2',[channelId,userId]);
      await audit(client,channelId,req.user.userId,userId,'channel_unbanned',{});
    });
    await refreshChannelSockets(req, channelId);
    res.json({enforced:false,banned:false});
  } catch(err) {respondError(res,err);}
});
router.get('/users/:userId/departments', async (req,res) => {
  try {
    const userId=positiveId(req.params.userId); if(!userId) throw fail(400,'Invalid user ID');
    if (userId !== req.user.userId && !(await can(query,req.user.userId,'manage_people'))) throw fail(403,'People management required');
    const result=await query('SELECT department_id,is_primary FROM user_departments WHERE user_id=$1 ORDER BY is_primary DESC,department_id',[userId]);
    res.json({departments:result.rows});
  } catch(err) {respondError(res,err);}
});
router.put('/users/:userId/departments',async(req,res)=>{
  try {
    const userId=positiveId(req.params.userId); if(!userId) throw fail(400,'Invalid user ID');
    if(!(await can(query,req.user.userId,'manage_people'))) throw fail(403,'People management required');
    const {departmentIds,primary}=membershipInput(req.body);
    if(req.body?.confirmAccessChanges !== true) throw fail(400,'Confirm department-based channel access changes');
    await transaction(async client => {
      await verifyEmployees(client,[userId]);
      if(departmentIds.length) {
        const found=(await client.query('SELECT id FROM departments WHERE id=ANY($1::integer[])',[departmentIds])).rows;
        if(found.length !== departmentIds.length) throw fail(400,'Unknown department');
      }
      await client.query('DELETE FROM user_departments WHERE user_id=$1',[userId]);
      for(const id of departmentIds) await client.query('INSERT INTO user_departments(user_id,department_id,is_primary) VALUES($1,$2,$3)',[userId,id,id===primary]);
      await client.query('UPDATE users SET department_id=$1 WHERE id=$2',[primary,userId]);
      await audit(client,null,req.user.userId,userId,'user_departments_changed',{departmentIds,primary});
    });
    // Revalidate all sockets belonging to the edited employee; their old department
    // might have been their only channel grant.
    if (req.io) {
      try {
        const rooms = await req.io.fetchSockets();
        const channels = new Set();
        for (const sock of rooms) {
          if (Number(sock.data?.watching || sock.data?.userId) !== userId) continue;
          for (const room of sock.rooms) {
            const match = /^channel_(\d+)$/.exec(room);
            if (match) channels.add(Number(match[1]));
          }
        }
        for (const channelId of channels) await refreshChannelSockets(req, channelId);
      } catch (error) { console.error('Department socket reconciliation failed:', error); }
    }
    res.json({departmentIds,primaryDepartmentId:primary,enforced:false});
  } catch(err) {respondError(res,err);}
});
module.exports=router;
