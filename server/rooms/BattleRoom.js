import colyseusPkg from "colyseus";
const { Room } = colyseusPkg;

// Список модулей для каждого типа техники (дублирует клиентскую логику)
const TANK_MODULES  = ['engine','transmission','leftTrack','rightTrack','gun','breech','turretTraverse','gunElevation','ammoRack'];
const PTUR_MODULES  = ['engine','radiator','wheelFL','wheelFR','wheelML','wheelMR','wheelRL','wheelRR','launcher','ammoRack'];
const BMP_MODULES   = ['engine','transmission','leftTrack','rightTrack','gun','breech','turretTraverse','gunElevation'];

function getModulesList(type) {
  if (type === 'ptur') return PTUR_MODULES;
  if (type === 'bmp') return BMP_MODULES;
  return TANK_MODULES;
}

function createModulesState(type) {
  const mods = {};
  getModulesList(type).forEach(n => mods[n] = { hp: 100, damaged: false, destroyed: false });
  return mods;
}

export class BattleRoom extends Room {
  maxClients = 4;

  onCreate(options) {
    this.customRoomName = options.roomKey || "Бой";
    this.roomPassword = options.password || null;
    this.setMetadata({ roomKey: this.customRoomName });

    // Наш собственный реестр игроков
    this.mpPlayers = {};   // sessionId -> { sessionId, nickname, x, y, z, hullYaw, turretYaw, gunPitch, health, vehicleType }

    // Клиент прислал своё состояние — сохраняем и рассылаем остальным
    this.onMessage("state", (client, data) => {
      const p = this.mpPlayers[client.sessionId];
      if (!p) return;
      p.x = data.x; p.y = data.y; p.z = data.z;
      p.hullYaw = data.hullYaw;
      p.turretYaw = data.turretYaw;
      p.gunPitch = data.gunPitch;
      this.broadcast("stateSync", p, { except: client });
    });

    // Выстрел — ретранслируем всем, кроме стрелявшего
    this.onMessage("shoot", (client, data) => {
      this.broadcast("shoot", { sessionId: client.sessionId, ...data }, { except: client });
    });

    // Пулемётное попадание: HP не трогаем, ведём счётчик попаданий по модулю.
    // Через 10 попаданий в гусеницу или 20 в орудие — ломаем модуль.
    this.onMessage("mgHit", (client, data) => {
      const target = this.mpPlayers[data.targetId];
      if (!target) return;
      if (target.health <= 0) return;
      const mod = data.module;
      if (mod === 'leftTrack' || mod === 'rightTrack') {
        target.mgHitTracks = (target.mgHitTracks || 0) + 1;
        if (target.mgHitTracks >= 10) {
          target.mgHitTracks = 0;
          const module = target.modules && target.modules[mod];
          if (module && !module.damaged) {
            module.damaged = true;
            module.hp = 0;
            this.broadcast("moduleUpdate", { sessionId: data.targetId, module: mod, damaged: true, destroyed: false });
          }
        }
      } else if (mod === 'gun' || mod === 'breech') {
        target.mgHitGun = (target.mgHitGun || 0) + 1;
        if (target.mgHitGun >= 20) {
          target.mgHitGun = 0;
          const module = target.modules && target.modules['gun'];
          if (module && !module.damaged) {
            module.damaged = true;
            module.hp = 0;
            this.broadcast("moduleUpdate", { sessionId: data.targetId, module: 'gun', damaged: true, destroyed: false });
          }
        }
      }
    });

    // Попадание — обновляем здоровье цели у всех
    this.onMessage("hit", (client, data) => {
      const target = this.mpPlayers[data.targetId];
      if (!target) return;
      if (target.health <= 0) return;   // уже мёртв

      const modName = data.module;
      const baseDmg = data.damage || 20;
      const module = (modName && target.modules) ? target.modules[modName] : null;

      // Снижение урона, если модуль уже сломан (как в одиночке)
      let effectiveDmg = baseDmg;
      if (module && (module.damaged || module.destroyed)) {
        const penalty = (modName === 'engine' || modName === 'transmission' || modName === 'radiator') ? 10 : 4;
        effectiveDmg = Math.max(0, baseDmg - penalty);
      }

      // Детонация БК: мгновенное уничтожение
      if (module && modName === 'ammoRack' && !module.destroyed && !data.isMG) {
        module.damaged = true;
        module.destroyed = true;
        module.hp = 0;
        target.health = 0;
        this.broadcast("moduleUpdate", { sessionId: data.targetId, module: modName, damaged: true, destroyed: true });
        this.broadcast("healthUpdate", { sessionId: data.targetId, health: 0 });
        this.broadcast("playerDied", { sessionId: data.targetId, killerId: client.sessionId, reason: 'ammoRack' });
        return;
      }

      target.health = Math.max(0, target.health - effectiveDmg);

      // Обновление состояния модуля
      let moduleChanged = false;
      if (module) {
        if (data.isAutocannon) {
          // БМП: накопительный урон, ломается когда hp <= 0
          module.hp -= 20;
          if (module.hp <= 0 && !module.damaged) {
            module.damaged = true;
            moduleChanged = true;
          }
        } else if (!module.damaged && !module.destroyed) {
          // Обычное попадание впервые ломает модуль
          module.hp = 0;
          module.damaged = true;
          if (data.isRocket) module.destroyed = true;
          moduleChanged = true;
        }
      }

      this.broadcast("healthUpdate", { sessionId: data.targetId, health: target.health });
      if (moduleChanged) {
        this.broadcast("moduleUpdate", {
          sessionId: data.targetId, module: modName,
          damaged: module.damaged, destroyed: module.destroyed
        });
      }
      if (target.health <= 0) {
        this.broadcast("playerDied", { sessionId: data.targetId, killerId: client.sessionId });
      }
    });

    console.log(`[${this.roomId}] создана: "${this.customRoomName}", пароль: ${this.roomPassword ? "да" : "нет"}`);
  }

  onAuth(client, options) {
    if (this.roomPassword && options.password !== this.roomPassword) {
      throw new Error("Неверный пароль");
    }
    return true;
  }

  onJoin(client, options) {
    const vType = options.vehicleType || 'tank';
    const p = {
      sessionId: client.sessionId,
      nickname: options.nickname || "Игрок",
      x: 0, y: 0, z: 400,
      hullYaw: 0, turretYaw: 0, gunPitch: 0,
      health: 100,
      vehicleType: vType,
      modules: createModulesState(vType),
      mgHitTracks: 0,
      mgHitGun: 0
    };
    this.mpPlayers[client.sessionId] = p;

    // Новому игроку — список всех, кто уже здесь
    const others = {};
    for (const sid in this.mpPlayers) {
      if (sid !== client.sessionId) others[sid] = this.mpPlayers[sid];
    }
    client.send("existingPlayers", others);

    // Всем остальным — что пришёл новичок
    this.broadcast("playerJoined", p, { except: client });

    console.log(`[${this.roomId}] + ${p.nickname} (${client.sessionId}), всего: ${Object.keys(this.mpPlayers).length}`);
  }

  onLeave(client) {
    const p = this.mpPlayers[client.sessionId];
    delete this.mpPlayers[client.sessionId];
    this.broadcast("playerLeft", { sessionId: client.sessionId });
    console.log(`[${this.roomId}] - ${p ? p.nickname : client.sessionId}, всего: ${Object.keys(this.mpPlayers).length}`);
  }

  onDispose() {
    console.log(`[${this.roomId}] закрыта`);
  }
}