/**
 * 猜人名小游戏 —— 局域网服务器
 * 玩法：额头贴名字 (Headbandz)
 * 启动：node server.js
 */
const express = require('express');
const http = require('http');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 6;

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ===== 全局唯一房间状态 =====
const room = {
  phase: 'lobby', // lobby | assigning | playing | ended
  hostId: null,
  players: new Map(), // id -> { id, name, ws, alive, target, guessed, assigneeId }
  // 当前提问者 id（轮转）
  currentAskerIdx: 0,
  askerOrder: [], // 玩家 id 顺序
  history: [],    // 历史记录
  // 回合状态：当前提问者本回合是否问过至少一个问题（问过后才能猜或跳过）
  turnAsked: false,
};

const VOTE_KINDS = ['yes', 'no', 'maybe', 'both'];

function broadcast(payload) {
  const msg = JSON.stringify(payload);
  for (const p of room.players.values()) {
    if (p.ws.readyState === 1) p.ws.send(msg);
  }
}

function sendTo(playerId, payload) {
  const p = room.players.get(playerId);
  if (p && p.ws.readyState === 1) p.ws.send(JSON.stringify(payload));
}

function publicState() {
  // 出题阶段：不暴露任何已分配信息
  // 游戏阶段：每个人能看到别人的 target，但看不到自己的
  return {
    phase: room.phase,
    hostId: room.hostId,
    minPlayers: MIN_PLAYERS,
    maxPlayers: MAX_PLAYERS,
    players: [...room.players.values()].map(p => ({
      id: p.id,
      name: p.name,
      isHost: p.id === room.hostId,
      isSpectator: !!p.isSpectator,
      alive: p.alive,
      guessed: p.guessed,
      submittedTarget: room.phase === 'assigning' ? !!getSubmittedTargetFor(p.id) : undefined,
    })),
    askerId: room.askerOrder[room.currentAskerIdx] || null,
    askerOrder: room.askerOrder,
    turnAsked: room.turnAsked,
    history: room.history.slice(-200),
  };
}

// 在 assigning 阶段：返回该玩家需要给谁出题（被分配为出题者的对象）
function getAssigneeOf(playerId) {
  // playerId 给谁出题：找到 assigneeId === playerId 的人
  for (const p of room.players.values()) {
    if (p.assigneeId === playerId) return p;
  }
  return null;
}

function getSubmittedTargetFor(playerId) {
  // 该玩家自己（playerId）的 target 是否已被别人提交
  const me = room.players.get(playerId);
  return me && me.target;
}

// 给每个玩家发个性化状态（带 viewTargets：自己看不到自己的 target）
function pushStateToAll() {
  const base = publicState();
  for (const p of room.players.values()) {
    const personal = {
      ...base,
      youId: p.id,
      yourName: p.name,
      youAreSpectator: !!p.isSpectator,
      // 游戏阶段：你能看到别人的 target，看不到自己的
      // 观众也能看到所有正式玩家的 target（旁观体验）
      viewTargets: room.phase === 'playing' || room.phase === 'ended'
        ? [...room.players.values()]
            .filter(q => q.id !== p.id && !q.isSpectator)
            .map(q => ({ id: q.id, name: q.name, target: q.target, guessed: q.guessed }))
        : [],
      // 出题阶段：你需要给谁出题（观众没有 assignee）
      yourAssignee: room.phase === 'assigning' && !p.isSpectator
        ? (() => {
            const a = getAssigneeOf(p.id);
            return a ? { id: a.id, name: a.name, submitted: !!a.target } : null;
          })()
        : null,
      // 游戏结束阶段：把自己的 target 也展示出来（观众没有）
      yourTarget: (room.phase === 'ended' && !p.isSpectator) ? p.target : undefined,
    };
    if (p.ws.readyState === 1) p.ws.send(JSON.stringify({ type: 'state', state: personal }));
  }
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// 随机配对：每个人给"另一个人"出题，且不能给自己出
// 用一个错位排列(derangement)
function buildDerangement(ids) {
  if (ids.length < 2) return null;
  for (let attempt = 0; attempt < 200; attempt++) {
    const shuffled = shuffle(ids);
    let ok = true;
    for (let i = 0; i < ids.length; i++) {
      if (shuffled[i] === ids[i]) { ok = false; break; }
    }
    if (ok) {
      // shuffled[i] 是 ids[i] 要给谁出题（assignee）
      return ids.map((id, i) => [id, shuffled[i]]);
    }
  }
  return null;
}

function startAssigning() {
  if (room.phase !== 'lobby') return;
  // 把所有人都转成正式玩家（包括上局结束后还在的观众）
  for (const p of room.players.values()) {
    if (room.players.size <= MAX_PLAYERS) p.isSpectator = false;
  }
  // 只取正式玩家（非观众）参与
  const ids = [...room.players.values()].filter(p => !p.isSpectator).map(p => p.id);
  if (ids.length < MIN_PLAYERS) return;
  const pairs = buildDerangement(ids);
  if (!pairs) return;
  // pair: [出题者id, 被出题者id]
  // 在被出题者身上记 assigneeId = 出题者id
  for (const p of room.players.values()) {
    p.target = null;
    p.guessed = false;
    p.alive = true;
    p.assigneeId = null;
  }
  for (const [askerId, targetId] of pairs) {
    const target = room.players.get(targetId);
    target.assigneeId = askerId;
  }
  room.phase = 'assigning';
  room.history = [];
  pushStateToAll();
}

function tryStartPlaying() {
  // 所有正式玩家都已被出题
  for (const p of room.players.values()) {
    if (p.isSpectator) continue;
    if (!p.target) return false;
  }
  room.phase = 'playing';
  // 提问顺序只包含正式玩家
  room.askerOrder = shuffle([...room.players.values()].filter(p => !p.isSpectator).map(p => p.id));
  room.currentAskerIdx = 0;
  room.turnAsked = false;
  pushStateToAll();
  return true;
}

function nextAsker() {
  if (room.askerOrder.length === 0) return;
  // 从下一个开始，跳过已猜中的人
  for (let i = 1; i <= room.askerOrder.length; i++) {
    const idx = (room.currentAskerIdx + i) % room.askerOrder.length;
    const p = room.players.get(room.askerOrder[idx]);
    if (p && !p.guessed) {
      room.currentAskerIdx = idx;
      room.turnAsked = false; // 新回合重置
      return;
    }
  }
  // 全部猜中
  room.phase = 'ended';
  room.turnAsked = false;
}

function genId() {
  return Math.random().toString(36).slice(2, 10);
}

wss.on('connection', (ws) => {
  let myId = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    switch (msg.type) {
      case 'join': {
        // 大厅：直接当正式玩家加入（受 MAX_PLAYERS 限制）
        // 游戏中：自动变观众（只受总连接数限制，不计入 MAX_PLAYERS 玩家上限）
        const inLobby = room.phase === 'lobby';
        const activeCount = [...room.players.values()].filter(p => !p.isSpectator).length;
        if (inLobby && activeCount >= MAX_PLAYERS) {
          ws.send(JSON.stringify({ type: 'error', message: '房间已满' }));
          return;
        }
        // 观众数量也限制一下，避免无限堆积
        if (!inLobby) {
          const specCount = [...room.players.values()].filter(p => p.isSpectator).length;
          if (specCount >= 10) {
            ws.send(JSON.stringify({ type: 'error', message: '观众席已满，请稍后再来' }));
            return;
          }
        }
        myId = genId();
        const name = (msg.name || '').toString().trim().slice(0, 16) || `玩家${room.players.size + 1}`;
        room.players.set(myId, {
          id: myId, name, ws,
          alive: true, target: null, guessed: false, assigneeId: null,
          isSpectator: !inLobby, // 游戏中加入 = 观众
        });
        if (!room.hostId) room.hostId = myId;
        ws.send(JSON.stringify({ type: 'joined', youId: myId }));
        if (!inLobby) {
          sendTo(myId, { type: 'info', message: '游戏正在进行中，你以观众身份加入。下一局开始时会自动加入正式玩家。' });
        }
        pushStateToAll();
        break;
      }
      case 'rename': {
        const me = room.players.get(myId);
        if (!me) return;
        const name = (msg.name || '').toString().trim().slice(0, 16);
        if (!name) return;
        me.name = name;
        pushStateToAll();
        break;
      }
      case 'chat': {
        const me = room.players.get(myId);
        if (!me) return;
        const text = (msg.text || '').toString().trim().slice(0, 200);
        if (!text) return;
        room.history.push({
          kind: 'chat',
          playerId: myId,
          playerName: me.name,
          isSpectator: !!me.isSpectator,
          text,
          time: Date.now(),
        });
        pushStateToAll();
        break;
      }
      case 'startGame': {
        if (myId !== room.hostId) return;
        startAssigning();
        break;
      }
      case 'kick': {
        // 房主踢人（任何阶段都可以）
        if (myId !== room.hostId) return;
        const targetId = (msg.targetId || '').toString();
        if (!targetId || targetId === myId) return;
        const target = room.players.get(targetId);
        if (!target) return;
        const targetName = target.name;
        // 通知被踢者
        try {
          target.ws.send(JSON.stringify({ type: 'kicked', message: '你被房主移出了房间' }));
        } catch {}
        // 关闭其连接（close 处理里会自动删除并触发 phase 重置）
        try { target.ws.close(); } catch {}
        // 同时也立刻从 players 中移除（防止 close 异步延迟）
        room.players.delete(targetId);
        // 游戏中踢人 -> 本局结束回大厅
        if (room.phase !== 'lobby') {
          room.phase = 'lobby';
          room.askerOrder = [];
          room.currentAskerIdx = 0;
          room.turnAsked = false;
          for (const p of room.players.values()) {
            p.target = null;
            p.guessed = false;
            p.alive = true;
            p.assigneeId = null;
            p.isSpectator = false; // 上局观众也转正
          }
          room.history.push({
            kind: 'system',
            text: `房主把 ${targetName} 移出了房间，本局结束，回到大厅`,
            time: Date.now(),
          });
        } else {
          room.history.push({
            kind: 'system',
            text: `房主把 ${targetName} 移出了房间`,
            time: Date.now(),
          });
        }
        pushStateToAll();
        break;
      }
      case 'disband': {
        // 房主解散：把所有人踢回各自的"输入昵称"页面
        if (myId !== room.hostId) return;
        const broadcastMsg = JSON.stringify({ type: 'disbanded', message: '房主解散了房间' });
        for (const p of [...room.players.values()]) {
          try { p.ws.send(broadcastMsg); } catch {}
          try { p.ws.close(); } catch {}
        }
        room.players.clear();
        room.phase = 'lobby';
        room.hostId = null;
        room.askerOrder = [];
        room.currentAskerIdx = 0;
        room.turnAsked = false;
        room.history = [];
        break;
      }
      case 'backToLobby': {
        // 房主主动结束当前对局回到大厅（游戏中或结束页都可用）
        if (myId !== room.hostId) return;
        if (room.phase === 'lobby') return;
        const me = room.players.get(myId);
        room.phase = 'lobby';
        room.askerOrder = [];
        room.currentAskerIdx = 0;
        room.turnAsked = false;
        for (const p of room.players.values()) {
          p.target = null;
          p.guessed = false;
          p.alive = true;
          p.assigneeId = null;
          p.isSpectator = false; // 观众转正
        }
        room.history.push({
          kind: 'system',
          text: `房主${me ? '（' + me.name + '）' : ''}结束了本局，回到大厅`,
          time: Date.now(),
        });
        pushStateToAll();
        break;
      }
      case 'submitTarget': {
        if (room.phase !== 'assigning') return;
        const me = room.players.get(myId);
        if (!me) return;
        const assignee = getAssigneeOf(myId);
        if (!assignee) return;
        const target = (msg.target || '').toString().trim().slice(0, 32);
        if (!target) return;
        assignee.target = target;
        if (!tryStartPlaying()) pushStateToAll();
        break;
      }
      case 'ask': {
        if (room.phase !== 'playing') return;
        if (room.askerOrder[room.currentAskerIdx] !== myId) return;
        // 每回合只能问一次
        if (room.turnAsked) {
          sendTo(myId, { type: 'error', message: '本回合已经问过一次了，请选择猜测或跳过' });
          return;
        }
        const text = (msg.text || '').toString().trim().slice(0, 200);
        if (!text) return;
        const me = room.players.get(myId);
        room.history.push({
          kind: 'question',
          askerId: myId,
          askerName: me.name,
          text,
          time: Date.now(),
          votes: { yes: [], no: [], maybe: [], both: [] },
          questionId: genId(),
        });
        room.turnAsked = true;
        pushStateToAll();
        break;
      }
      case 'vote': {
        if (room.phase !== 'playing') return;
        const last = [...room.history].reverse().find(h => h.kind === 'question');
        if (!last) return;
        if (msg.questionId && msg.questionId !== last.questionId) return;
        if (last.askerId === myId) return; // 提问者不能投票
        // 清除该人之前的投票
        for (const k of VOTE_KINDS) {
          last.votes[k] = last.votes[k].filter(v => (typeof v === 'string' ? v : v.id) !== myId);
        }
        if (VOTE_KINDS.includes(msg.choice)) {
          const comment = (msg.comment || '').toString().trim().slice(0, 80);
          // 始终用对象格式 { id, comment }，便于前端统一处理
          last.votes[msg.choice].push({ id: myId, comment });
        }
        pushStateToAll();
        break;
      }
      case 'nextAsker': {
        if (room.phase !== 'playing') return;
        if (room.askerOrder[room.currentAskerIdx] !== myId) return;
        const me = room.players.get(myId);
        room.history.push({
          kind: 'system',
          text: `${me.name} 选择跳过本回合，没有猜测`,
          time: Date.now(),
        });
        nextAsker();
        pushStateToAll();
        break;
      }
      case 'guess': {
        if (room.phase !== 'playing') return;
        const me = room.players.get(myId);
        if (!me || me.guessed) return;
        // 只能在自己回合里猜
        if (room.askerOrder[room.currentAskerIdx] !== myId) {
          sendTo(myId, { type: 'error', message: '不在你的回合，无法猜测' });
          return;
        }
        const guess = (msg.guess || '').toString().trim();
        if (!guess) return;
        const correct = me.target && (
          me.target.toLowerCase() === guess.toLowerCase() ||
          me.target.replace(/\s+/g, '') === guess.replace(/\s+/g, '')
        );
        room.history.push({
          kind: 'guess',
          playerId: myId,
          playerName: me.name,
          guess,
          target: me.target,
          correct,
          time: Date.now(),
        });
        if (correct) {
          me.guessed = true;
          // 检查是否全部猜中
          const allGuessed = [...room.players.values()].every(p => p.guessed);
          if (allGuessed) {
            room.phase = 'ended';
            room.turnAsked = false;
          } else {
            // 猜中后回合结束，交给下一位
            nextAsker();
          }
        } else {
          // 猜错：回合直接结束
          nextAsker();
        }
        pushStateToAll();
        break;
      }
      case 'restart': {
        if (myId !== room.hostId) return;
        room.phase = 'lobby';
        room.history = [];
        room.askerOrder = [];
        room.currentAskerIdx = 0;
        room.turnAsked = false;
        for (const p of room.players.values()) {
          p.target = null;
          p.guessed = false;
          p.alive = true;
          p.assigneeId = null;
          p.isSpectator = false; // 观众在新一局自动转正
        }
        pushStateToAll();
        break;
      }
    }
  });

  ws.on('close', () => {
    if (!myId) return;
    const me = room.players.get(myId);
    if (!me) return;
    room.players.delete(myId);

    // 房主转移
    if (room.hostId === myId) {
      const next = room.players.keys().next();
      room.hostId = next.done ? null : next.value;
    }

    // 如果房间空了，重置
    if (room.players.size === 0) {
      room.phase = 'lobby';
      room.hostId = null;
      room.askerOrder = [];
      room.currentAskerIdx = 0;
      room.turnAsked = false;
      room.history = [];
      return;
    }

    // 游戏中有人退出
    if (room.phase !== 'lobby') {
      // 观众离开不影响游戏
      if (me.isSpectator) {
        room.history.push({ kind: 'system', text: `观众 ${me.name} 离开了房间`, time: Date.now() });
      } else {
        // 正式玩家离开 -> 结束当局回到大厅
        room.phase = 'lobby';
        room.askerOrder = [];
        room.currentAskerIdx = 0;
        room.turnAsked = false;
        for (const p of room.players.values()) {
          p.target = null;
          p.guessed = false;
          p.alive = true;
          p.assigneeId = null;
          p.isSpectator = false; // 观众转正
        }
        room.history.push({ kind: 'system', text: `${me.name} 离开了房间，本局结束，回到大厅`, time: Date.now() });
      }
    }
    pushStateToAll();
  });
});

function getLocalIPs() {
  const ifaces = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name]) {
      if (ni.family === 'IPv4' && !ni.internal) ips.push(ni.address);
    }
  }
  return ips;
}

server.listen(PORT, '0.0.0.0', () => {
  console.log('\n=== 猜人名小游戏 服务已启动 ===');
  console.log(`本机访问:   http://localhost:${PORT}`);
  for (const ip of getLocalIPs()) {
    console.log(`局域网访问: http://${ip}:${PORT}`);
  }
  console.log('\n把上面"局域网访问"的地址发给同事，他们用浏览器打开即可加入。\n按 Ctrl+C 关闭服务。\n');
});
