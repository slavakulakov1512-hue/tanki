import colyseusPkg from "colyseus";
const { Room } = colyseusPkg;

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

    // Попадание — обновляем здоровье цели у всех
    this.onMessage("hit", (client, data) => {
      const target = this.mpPlayers[data.targetId];
      if (!target) return;
      if (target.health <= 0) return;   // уже мёртв, не считаем повторно
      target.health = Math.max(0, target.health - (data.damage || 0));
      this.broadcast("healthUpdate", { sessionId: data.targetId, health: target.health });
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
    const p = {
      sessionId: client.sessionId,
      nickname: options.nickname || "Игрок",
      x: 0, y: 0, z: 400,
      hullYaw: 0, turretYaw: 0, gunPitch: 0,
      health: 100,
      vehicleType: options.vehicleType || 'tank'
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