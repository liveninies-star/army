const { spawn } = require('child_process');
const path = require('path');
const mineflayer = require('mineflayer');
const { createMouse } = require('mineflayer-mouse');
const bloodhound = require('mineflayer-bloodhound');
const Vec3 = require('vec3');

const USERNAME = 'z23Army';
const HOST = 'play.trexmine.com';
const config = {
  host: HOST,
  port: 25565,
  username: USERNAME,
  version: '1.21.4',
  logErrors: true,
  hideErrors: false,
  owners: new Set(['DamnBoredom','XxLiVe', 'UhSry', 'YouWereBoring']),
  blacklist: new Set(),
  patrolPoints: [new Vec3(261, 64, 90), new Vec3(261, 64, 75)],
  pvpCommand: '/pvp',
  attackRange: 10,
  guarding: null,
  MaxDist: 7,
  lastSeenPositions: {}
};

const state = {
  currentPatrolIndex: 0,
  isPatrolling: false,
  jumpCooldown: false,
  strafeCooldown: false,
  attackCooldown: false,
  isHealing: false,
  resumeAfterHealing: null,
  bot: null,
  lastGoldenAppleTime: 0,
  goldenAppleCooldown: 8000,
  strafeDirection: null,
  nextStrafeSwitch: 0,
  flickInProgress: false,
  lastFlickCall: 0,
  messageSets: new Map(), // Store message sets by name
  activeMessageSets: new Map(),
};

const movement = {
  moveForward: (target) => {
    const bot = state.bot;
    const LookTarget = target.offset(0, 1.6, 0);
    flickHeadAt(LookTarget, 0.6, 0.01);
    ['back', 'left', 'right'].forEach(key => bot.setControlState(key, false));
    bot.setControlState('forward', true);
    bot.setControlState('sprint', false);
    const dir = target.minus(bot.entity.position).normalize();
    const checkDistance = 0.6;
    const groundCheck = bot.entity.position.offset(dir.x * checkDistance, 0, dir.z * checkDistance);
    const headCheck = groundCheck.offset(0, 1, 0);
    const aboveCheck = headCheck.offset(0, 1, 0);
    const groundBlock = bot.blockAt(groundCheck);
    const headBlock = bot.blockAt(headCheck);
    const aboveBlock = bot.blockAt(aboveCheck);
    if (groundBlock?.boundingBox === 'block' && (!headBlock || headBlock.boundingBox === 'empty') && bot.entity.onGround) {
      bot.setControlState('jump', true);
      setTimeout(() => bot.setControlState('jump', false), 250);
      return;
    }  
    if (groundBlock?.boundingBox === 'block' && headBlock?.boundingBox === 'block' && !state.strafing) {
      state.strafing = true;
      const side = Math.random() > 0.5 ? 'left' : 'right';
      bot.setControlState(side, true);
      setTimeout(() => {
        bot.setControlState(side, false);
        state.strafing = false;
      }, 400);
    }
  },
  moveBackward: () => {
    const bot = state.bot;
    bot.setControlState('forward', false);
    bot.setControlState('back', true);
    const yaw = bot.entity.yaw + (Math.random() - 0.5) * 0.5;
    const pitch = Math.max(-Math.PI/4, bot.entity.pitch + (Math.random() - 0.5) * 0.3);
    bot.look(yaw, pitch, false);
  },
  hasReachedPoint: (targetPoint) => {
    const bot = state.bot;
    const dist = bot.entity.position.distanceTo(targetPoint);
    return dist < 1 || (Math.abs(bot.entity.position.x - targetPoint.x) < 0.8 && Math.abs(bot.entity.position.z - targetPoint.z) < 0.8);
  }
};

function isNearAnyPatrolPoint(position) {
  return config.patrolPoints.some(point => point.distanceTo(position) <= config.MaxDist);
}

function normalizeZone(zone) {
  const minX = Math.min(zone.min.x, zone.max.x);
  const maxX = Math.max(zone.min.x, zone.max.x);
  const minY = Math.min(zone.min.y, zone.max.y);
  const maxY = Math.max(zone.min.y, zone.max.y);
  const minZ = Math.min(zone.min.z, zone.max.z);
  const maxZ = Math.max(zone.min.z, zone.max.z);
  return { min: new Vec3(minX, minY, minZ), max: new Vec3(maxX, maxY, maxZ) };
}

const pvpZones = [normalizeZone({ min: new Vec3(240, 64, 110), max: new Vec3(347, 81, 18) })];

function isInsideZone(pos, zone) {
  return pos.x >= zone.min.x && pos.x <= zone.max.x && pos.y >= zone.min.y && pos.y <= zone.max.y && pos.z >= zone.min.z && pos.z <= zone.max.z;
}
function isInsideAnyZone(pos) {
  return pvpZones.some(zone => isInsideZone(pos, zone));
}
function randomTag(length = 5) {
  const chars = 'abcdefghijklmnopqrstuvwxyz';
  let out = '';
  for (let i = 0; i < length; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}

async function tryEatGoldenApple() {
  const bot = state.bot;
  const now = Date.now();
  if (state.isHealing || bot.health >= 12 || now - state.lastGoldenAppleTime < 8000) return;
  const goldenApple = bot.inventory.items().find(i => i.name.includes('apple'));
  if (!goldenApple) return;
  const wasAttacking = combat.target;
  const wasPatrolling = state.isPatrolling;
  const wasGuarding = config.guarding;
  combat.stopAttacking();
  patrol.stop();
  state.isHealing = true;
  state.lastGoldenAppleTime = now;
  bot.setControlState('back', true);
  const jumpInterval = setInterval(() => {
    bot.setControlState('jump', true);
    setTimeout(() => bot.setControlState('jump', false), 300);
  }, 800);
  try {
    await bot.equip(goldenApple, 'hand');
    await new Promise(resolve => setTimeout(resolve, 500));
    await bot.consume();
  } catch (err) {
    console.log("❌ Eat failed:", err.message);
  } finally {
    clearInterval(jumpInterval);
    bot.setControlState('back', false);
    bot.setControlState('jump', false);
    state.isHealing = false;
    resumePreviousState(wasPatrolling || wasGuarding, wasAttacking);
  }
}

function resumePreviousState(wasPatrolling, attackTarget) {
  const bot = state.bot;
  bot.setQuickBarSlot(0);
  setTimeout(() => {
    if (attackTarget && combat.isValidTarget(attackTarget)) {
      combat.startAttacking(attackTarget);
    } else if (config.guarding) {
      const guardPlayer = Object.values(bot.entities).find(
        e => e.type === 'player' && e.username === config.guarding
      );
      if (guardPlayer?.position) {
        patrol.start();
      }
    } else if (wasPatrolling) {
      patrol.start();
    }
  }, 100);
}

function flickHeadAt(targetPos, speed = 0.6, jitter = 0.01) {
  const now = Date.now();
  if (state.flickInProgress) return; // prevent overlapping flicks

  const bot = state.bot;
  const normalizeAngle = angle => {
    while (angle > Math.PI) angle -= 2 * Math.PI;
    while (angle < -Math.PI) angle += 2 * Math.PI;
    return angle;
  };

  const from = bot.entity.position.offset(0, bot.entity.height, 0);
  const jittered = targetPos.offset(
    (Math.random() - 0.5) * jitter,
    (Math.random() - 0.5) * jitter,
    (Math.random() - 0.5) * jitter
  );
  const delta = jittered.minus(from);
  const targetYaw = Math.atan2(-delta.x, -delta.z);
  const targetPitch = Math.atan2(delta.y, Math.sqrt(delta.x ** 2 + delta.z ** 2));

  const currentYaw = bot.entity.yaw;
  const currentPitch = bot.entity.pitch;
  const yawDiff = normalizeAngle(targetYaw - currentYaw);
  const pitchDiff = targetPitch - currentPitch;

  // --- NEW: adaptive step calculation ---
  const maxYawPerStep = 0.06;    // radians per step (~3.4°)
  const maxPitchPerStep = 0.06;  // radians per step (~3.4°)
  const steps = Math.max(
    1,
    Math.ceil(Math.abs(yawDiff) / maxYawPerStep),
    Math.ceil(Math.abs(pitchDiff) / maxPitchPerStep)
  );

  state.flickInProgress = true;
  state.lastFlickCall = now;

  let accumulatedDelay = 0;
  for (let step = 1; step <= steps; step++) {
    const progress = step / steps;
    const yaw = currentYaw + yawDiff * Math.pow(progress, speed);
    const pitch = currentPitch + pitchDiff * Math.pow(progress, speed);
    const delay = Math.floor(Math.random() * 15) + 13; // keep small jitter
    accumulatedDelay += delay;
    setTimeout(() => {
      bot.look(yaw, pitch, true);
      if (step === steps) state.flickInProgress = false; // allow next flick
    }, accumulatedDelay);
  }
}

const combat = {
  _attackInterval: null,
  target: null,
  lastFlickTime: 0,
  _strafeTimeout: null,
  _lastEntityScan: 0, // ← ONLY ADDED THIS
  _ENTITY_SCAN_INTERVAL: 500, // ← ONLY ADDED THIS
  
  // ← ONLY ADDED THIS NEW METHOD
  _getEntities: function() {
    const now = Date.now();
    if (now - this._lastEntityScan < this._ENTITY_SCAN_INTERVAL) {
      return null; // Return null when throttled
    }
    this._lastEntityScan = now;
    return Object.values(state.bot.entities);
  },

  startAttacking: function (target) {
    this.stopAttacking();
    this.target = target;
    state.bot.setControlState('forward', true);
    state.bot.setControlState('sprint', false);
    this._attackInterval = setInterval(() => {
      if (!this.target || this.target.isRemoved || !this.isValidTarget(this.target)) {
        this.stopAttacking();
        return;
      }
      const now = Date.now(); 
      const botPos = state.bot.entity.position;
      if (now - this.lastFlickTime >= 100) {
        const targetPos = this.target.position.offset(0, 1.6, 0);
        flickHeadAt(targetPos, 0.6, 0.01);
        this.lastFlickTime = now;
    }
      
      // ← ONLY CHANGED THIS LINE:
      const entities = this._getEntities();
      if (entities) { // Only check closer targets if not throttled
        const currentDist = botPos.distanceTo(this.target.position);
        const closerTargets = entities
          .filter(e => e.id !== this.target.id && this.isValidTarget(e))
          .map(e => ({ entity: e, dist: botPos.distanceTo(e.position) }))
          .filter(e => e.dist + 2 <= currentDist)
          .sort((a, b) => a.dist - b.dist);   
        if (closerTargets.length > 0) {
          console.log(`[SWITCH] Switching to closer target: ${closerTargets[0].entity.username}`);
          this.startAttacking(closerTargets[0].entity);
          return;
        }
      }
      // If throttled, skip closer target check this cycle
      
      const entityUnderCursor = state.bot.entityAtCursor(config.attackRange);
      if ((!entityUnderCursor || config.blacklist.has(entityUnderCursor.username)) && state.bot.entity.position.distanceTo(this.target.position) <= 4) {
        state.bot.swingArm('left');
        state.bot.leftClick();
      }
    }, randomDelay(90, 110));
  },
  stopAttacking: function () {
    if (this._attackInterval) {
      clearInterval(this._attackInterval);
      this._attackInterval = null;
    }
    if (this._movementInterval) {
      clearInterval(this._movementInterval);
      this._movementInterval = null;
    }
    if (this._strafeTimeout) {
      clearTimeout(this._strafeTimeout);
      this._strafeTimeout = null;
    }
    this.target = null;
    state.bot.clearControlStates();
    state.bot.setControlState('left', false);
    state.bot.setControlState('right', false);
  },
  isValidTarget: function (entity) {
    return entity?.type === 'player' && entity.username && config.blacklist.has(entity.username) && entity.isValid && state.bot.entity.position.distanceTo(entity.position) <= config.attackRange && isInsideAnyZone(entity.position);
  },
  tryAttack: function () {
    if (state.isHealing) return false;
    // ← ONLY CHANGED THESE 2 LINES:
    const entities = this._getEntities();
    const target = entities ? entities.find(e => this.isValidTarget(e)) : this.target;
    if (target) {
      if (!this._attackInterval) this.startAttacking(target);
      return true;
    } else {
      this.stopAttacking();
      return false;
    }
  }
};

function randomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

const patrol = {
  start: () => {
    if (state.isPatrolling) return;
    state.isPatrolling = true;
    patrol.next();
  },
  next: () => {
    if (!state.isPatrolling) return;
    if (!combat.tryAttack()) {
      if (config.patrolPoints.length === 1) {
        const target = config.patrolPoints[0];
        if (movement.hasReachedPoint(target)) {
          state.bot.clearControlStates();
        } else {
          movement.moveForward(target);
        }
      } else if (config.guarding) {
        const player = Object.values(state.bot.entities).find(
          e => e.type === 'player' && e.username === config.guarding
        );
        if (player?.position) {
          config.lastSeenPositions[config.guarding] = player.position.clone();
          const distanceToPlayer = state.bot.entity.position.distanceTo(player.position);
          if (distanceToPlayer > 1.5) {
            movement.moveForward(player.position);
          } else {
            state.bot.clearControlStates();
          }
        } else {
          const lastSeen = config.lastSeenPositions[config.guarding];
          if (lastSeen) {
            if (movement.hasReachedPoint(lastSeen)) {
              state.bot.clearControlStates();
            } else {
              movement.moveForward(lastSeen);
            }
          } else {
            state.bot.clearControlStates();
          }
        }
      } else {
        const target = config.patrolPoints[state.currentPatrolIndex];
        if (target) {
          movement.moveForward(target);
          if (movement.hasReachedPoint(target)) {
            state.currentPatrolIndex = (state.currentPatrolIndex + 1) % config.patrolPoints.length;
          }
        }
      }
    }
    setTimeout(patrol.next, 250);
  },
  stop: () => {
    state.isPatrolling = false;
    ['forward', 'sprint', 'jump', 'left', 'right'].forEach(control => {
      state.bot.setControlState(control, false);
    });
  }
};

const messageQueue = [];
let sending = false;

const commands = {
  handle: (username, message) => {
    if (!config.owners.has(username)) return;
    const botUsernameRegex = new RegExp(`^${state.bot.username}\\s+`, 'i');
    const cleanedMsg = message.replace(botUsernameRegex, '').trim();
    const args = cleanedMsg.split(' ');
    const command = args.shift().toLowerCase();
    switch (command) {
      case 'patrol':
        patrol.start();
        state.bot.chat('Patrolling started.');
        break;
      case 'stop':
        patrol.stop();
        config.guarding = null;
        state.bot.chat('Bot stopped.');
        break;
      case 'blacklist':
        commands.handleBlacklist(args);
        break;
      case 'owner':
        commands.handleOwner(args);
        break;
      case 'send':
        commands.handleSend(args);
          break;
          
        // ADD THIS NEW CASE HERE:
      case 'msend':
        commands.handleMSend(args);
          break;
      
        case 'e':
          if (args.length > 0) {
            let msg = args.join(' ');
            if (!msg.startsWith('/')) {
              msg += ``;
            }
            state.bot.chat(msg);
          }
          break;
        
      case 'guard':
        if (args.length !== 1) return state.bot.chat('Usage: guard <player>');
        config.guarding = args[0];
        state.bot.chat(`Now guarding ${args[0]}`);
        patrol.start();
        break;
    }
  },
  handleBlacklist: (args) => {
    const [action, target] = args;
    if (!action || !target) return state.bot.chat('Usage: blacklist add/remove <player>');
    if (action === 'add') {
      config.blacklist.add(target);
      state.bot.chat(`${target} added to blacklist.`);
    } else if (action === 'remove') {
      config.blacklist.delete(target);
      state.bot.chat(`${target} removed from blacklist.`);
    }
  },
  handleOwner: (args) => {
    const [action, target] = args;
    if (!action || !target) return state.bot.chat('Usage: owner add/remove <username>');
    if (action === 'add') {
      config.owners.add(target);
      state.bot.chat(`${target} is now an owner.`);
    } else if (action === 'remove') {
      config.owners.delete(target);
      state.bot.chat(`${target} removed from owners.`);
    }
  },
  
  handleSend: (args) => {
    if (args.length === 0) return;
    let count = 1;
    if (!isNaN(args[args.length - 1])) {
      count = parseInt(args.pop());
    }
    const msg = args.join(' ');
    messageQueue.push({ msg, count });
    if (sending) return;
    sending = true;
    const interval = setInterval(() => {
      let allDone = true;
      for (let i = 0; i < messageQueue.length; i++) {
        const task = messageQueue[i];
        if (task.count > 0) {
          let messageToSend = task.msg;
          // Only add tag if not a command
          if (!messageToSend.startsWith('/')) {
            messageToSend += ``;
          }
          state.bot.chat(messageToSend);
          task.count--;
          allDone = false;
          break;
        }
      }
      if (allDone) {
        clearInterval(interval);
        messageQueue.length = 0;
        sending = false;
      }
    }, 2050);
  },
  handleMSend: (args) => {
    if (args.length === 0) {
      state.bot.chat('Usage: msend <add/list/remove/start/stop/clear>');
      return;
    }
    
    const subcommand = args[0].toLowerCase();
    
    switch (subcommand) {
      case 'add':
        commands.handleMSendAdd(args.slice(1));
        break;
      case 'list':
        commands.handleMSendList();
        break;
      case 'remove':
        commands.handleMSendRemove(args.slice(1));
        break;
      case 'start':
        commands.handleMSendStart(args.slice(1));
        break;
      case 'stop':
        commands.handleMSendStop(args.slice(1));
        break;
      case 'clear':
        commands.handleMSendClear(args.slice(1));
        break;
      default:
        state.bot.chat('Unknown msend command. Use: add/list/remove/start/stop/clear');
    }
  },
  
  handleMSendAdd: (args) => {
    if (args.length < 3) {
      state.bot.chat('Usage: msend add <setName> <messageNumber> <message>');
      state.bot.chat('Example: msend add example 1 Hello world!');
      return;
    }
    
    const setName = args[0].toLowerCase();
    const messageNum = parseInt(args[1]);
    const message = args.slice(2).join(' ');
    
    if (isNaN(messageNum) || messageNum < 1) {
      state.bot.chat('Message number must be a positive integer');
      return;
    }
    
    if (!state.messageSets.has(setName)) {
      state.messageSets.set(setName, new Map());
    }
    
    const messageSet = state.messageSets.get(setName);
    messageSet.set(messageNum, message);
    
    state.bot.chat(`Added message ${messageNum} to set '${setName}': ${message}`);
  },
  
  handleMSendList: () => {
    if (state.messageSets.size === 0) {
      state.bot.chat('No message sets defined.');
      return;
    }
    
    state.bot.chat(`Available message sets (${state.messageSets.size}):`);
    
    for (const [setName, messages] of state.messageSets) {
      const sortedMessages = Array.from(messages.entries())
        .sort((a, b) => a[0] - b[0]);
      
      state.bot.chat(`- ${setName} (${messages.size} messages):`);
      
      for (const [num, msg] of sortedMessages) {
        state.bot.chat(`  ${num}: ${msg.substring(0, 30)}${msg.length > 30 ? '...' : ''}`);
      }
    }
  },
  
  handleMSendRemove: (args) => {
    if (args.length < 2) {
      state.bot.chat('Usage: msend remove <setName> <messageNumber>');
      return;
    }
    
    const setName = args[0].toLowerCase();
    const messageNum = parseInt(args[1]);
    
    if (!state.messageSets.has(setName)) {
      state.bot.chat(`Message set '${setName}' not found.`);
      return;
    }
    
    const messageSet = state.messageSets.get(setName);
    
    if (!messageSet.has(messageNum)) {
      state.bot.chat(`Message ${messageNum} not found in set '${setName}'.`);
      return;
    }
    
    messageSet.delete(messageNum);
    
    if (messageSet.size === 0) {
      state.messageSets.delete(setName);
      state.bot.chat(`Removed message ${messageNum} and deleted empty set '${setName}'.`);
    } else {
      state.bot.chat(`Removed message ${messageNum} from set '${setName}'.`);
    }
  },
  
  handleMSendStart: (args) => {
    if (args.length < 1) {
      state.bot.chat('Usage: msend start <setName> [repeatTimes]');
      return;
    }
    
    const setName = args[0].toLowerCase();
    const repeatTimes = args.length > 1 ? parseInt(args[1]) : 1;
    
    if (!state.messageSets.has(setName)) {
      state.bot.chat(`Message set '${setName}' not found.`);
      return;
    }
    
    if (isNaN(repeatTimes) || repeatTimes < 1) {
      state.bot.chat('Repeat times must be a positive integer');
      return;
    }
    
    // Stop if already running
    if (state.activeMessageSets.has(setName)) {
      commands.handleMSendStop([setName]);
    }
    
    const messageSet = state.messageSets.get(setName);
    const sortedMessages = Array.from(messageSet.entries())
      .sort((a, b) => a[0] - b[0])
      .map(entry => entry[1]);
    
    if (sortedMessages.length === 0) {
      state.bot.chat(`Message set '${setName}' is empty.`);
      return;
    }
    
    let currentCycle = 0;
    let messageIndex = 0;
    
    const sendNextMessage = () => {
      if (!state.activeMessageSets.has(setName)) return;
      
      const message = sortedMessages[messageIndex];
      
      let messageToSend = message;
      if (!message.startsWith('/')) {
        messageToSend += ``;
      }
      
      state.bot.chat(messageToSend);
      
      messageIndex++;
      
      if (messageIndex >= sortedMessages.length) {
        messageIndex = 0;
        currentCycle++;
        
        if (currentCycle >= repeatTimes) {
          clearInterval(intervalId);
          state.activeMessageSets.delete(setName);
          return;
        }
      }
      
      setTimeout(sendNextMessage, 2000 + Math.floor(Math.random() * 100));
    };
    
    const intervalId = {
      stop: () => clearTimeout(sendNextMessage)
    };
    
    state.activeMessageSets.set(setName, {
      intervalId: intervalId,
      setName: setName,
      messages: sortedMessages,
      currentCycle: currentCycle,
      totalCycles: repeatTimes
    });
    
    
    setTimeout(sendNextMessage, 2000);
  },
  
  handleMSendStop: (args) => {
    if (args.length < 1) {
      state.bot.chat('Usage: msend stop <setName>');
      return;
    }
    
    const setName = args[0].toLowerCase();
    
    if (!state.activeMessageSets.has(setName)) {
      state.bot.chat(`Message set '${setName}' is not currently running.`);
      return;
    }
    
    const activeSet = state.activeMessageSets.get(setName);
    if (activeSet && activeSet.intervalId) {
      activeSet.intervalId.stop();
    }
    state.activeMessageSets.delete(setName);
    
    state.bot.chat(`Stopped message set '${setName}'.`);
  },
  
  handleMSendClear: (args) => {
    if (args.length < 1) {
      state.bot.chat('Usage: msend clear <setName>');
      return;
    }
    
    const setName = args[0].toLowerCase();
    
    if (state.activeMessageSets.has(setName)) {
      commands.handleMSendStop([setName]);
    }
    
    if (state.messageSets.has(setName)) {
      state.messageSets.delete(setName);
      state.bot.chat(`Cleared message set '${setName}'.`);
    } else {
      state.bot.chat(`Message set '${setName}' not found.`);
    }
  }
  
};

function createBot() {
  state.bot = mineflayer.createBot(config);
  state.bot.loadPlugin(createMouse());
  state.bot.loadPlugin(bloodhound(mineflayer));
  state.bot._client.on('attach_entity', (packet) => {
    try {
    } catch (err) {
      console.warn('[VEHICLE HANDLER ERROR]', err.message);
    }
  });
  
  state.bot.on('heaalth', async () => {
    if (state.bot.health < 12) await tryEatGoldenApple();
  });
  state.bot.once('login', () => {
    console.log('Bot logged in.');
    setTimeout(() => state.bot.chat('/register arm123 arm123'), 2000);
    setTimeout(() => state.bot.chat('/login light123'), 4000);
  });
  state.bot.on('spawn', () => {
    if (!state.bot.bloodhound) {
      console.log('Bloodhound plugin failed to load.')
      return
    }
    state.bot.bloodhound.yaw_correlation_enabled = true
    setTimeout(() => state.bot.chat(config.pvpCommand), 1500);
    setTimeout(() => state.bot.setControlState('jump',true), 2000);
    setTimeout(() => state.bot.setControlState('jump',false), 2500);
    if (state.isPatrolling) {
      console.log("Respawned. Waiting 5s before resuming patrol...");
      setTimeout(() => {
        if (state.isPatrolling) patrol.start();
      }, 5000); 
    }
  });
  
  state.bot.on('death', () => {
    console.log('Bot died, restarting patrol.');
    state.currentPatrolIndex = 0;
    if (state.isPatrolling) {
      patrol.start();
    }
  });
  // Remove the default chat handler
state.bot.removeAllListeners('chat');

// Add our custom chat handler that works with ALL formats
state.bot.on('message', (jsonMsg) => {
  const msg = jsonMsg.toString();
  
  // Check if it's a chat message (has » symbol)
  if (msg.includes('»')) {
    // Extract player name: get last word before »
    const beforeArrow = msg.split('»')[0].trim();
    const words = beforeArrow.split(/\s+/);
    const rawName = words[words.length - 1];
    
    // Clean the name (remove non-alphanumeric/underscore from edges)
    const username = rawName.replace(/^[^\w]+|[^\w]+$/g, '');
    
    // Extract message (everything after first »)
    const message = msg.split('»').slice(1).join('»').trim();
    
    // Validate it's a Minecraft username
    if (username && /^[a-zA-Z0-9_]{3,16}$/.test(username)) {
      console.log(`[CHAT] ${username}: ${message}`);
      
      // Pass to your command handler
      commands.handle(username, message);
      return; // Stop here, we handled it
    }
  }
  
  // Log all other messages normally
  console.log('[SERVER]', msg);
});
  state.bot.on('end', () => {
    console.log('Bot disconnected. Reconnecting in 5s...');
    setTimeout(createBot, 5000);
  });
  state.bot.on('kicked', (reason) => {
    console.log(`[KICKED] Reason: ${reason}`);
  });
  state.bot.on('error', (err) => {
    console.error("[ERROR]", err);
  });
  state.bot.on('oCorrelateAttack', (attacker, victim, weapon) => {
    if (!victim) return;
    if (!attacker) return;
    if (!state.bot.entity || victim.id !== state.bot.entity.id) return;
    const attackerName = attacker.username ?? attacker.displayName;
    if (!attackerName) {
      console.log('[DEBUG] Attacker has no username or displayName');
      return;
    }
    const weaponName = weapon?.name || '';
    if (weaponName !== 'diamond_sword') return;
    if (config.blacklist.has(attackerName)) return;
    console.log(`[BLACKLIST] ${attackerName} attacked bot with a diamond sword - blacklisting for 15s`);
    config.blacklist.add(attackerName);
    const tempBlacklist = new Set();
    tempBlacklist.add(attackerName);
    setTimeout(() => {
      config.blacklist.delete(attackerName);
      tempBlacklist.delete(attackerName);
      console.log(`[BLACKLIST REMOVED] ${attackerName} removed`);
    }, 15000);
  });
}

function startProxyThenBot() {
  const proxyPath = path.join(__dirname, 'proxy.js');

  console.log('[BOT] Starting proxy.js...');
  console.log(`[BOT] Username: ${USERNAME}`);
  console.log(`[BOT] Host: ${HOST}`);

  const proxy = spawn(process.execPath, [proxyPath], {
    cwd: __dirname,
    env: {
      ...process.env,
      USNAME: USERNAME,
      HOST: HOST
    },
    stdio: 'inherit'
  });

  proxy.on('error', (err) => {
    console.error('[BOT] Failed to start proxy.js:', err);
  });

  proxy.on('exit', (code, signal) => {
    console.log(`[BOT] proxy.js exited with code ${code}${signal ? ` (signal: ${signal})` : ''}`);

    if (code === 42) {
      console.log('[BOT] proxy.js completed successfully. Starting Minecraft bot...');
      createBot();
    } else {
      console.log('[BOT] proxy.js did not exit with code 42. Bot will NOT start.');
    }
  });
}

startProxyThenBot();
