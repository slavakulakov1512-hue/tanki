import colyseusPkg from "colyseus";
import { createServer } from "http";
import express from "express";
import { BattleRoom } from "./rooms/BattleRoom.js";
const { Server } = colyseusPkg;

const port = process.env.PORT || 2567;
const app = express();
app.use(express.json());

const gameServer = new Server({ server: createServer(app) });

gameServer.define("battle", BattleRoom)
  .filterBy(["roomKey"]);
gameServer.listen(port);
console.log(`Colyseus слушает на ws://localhost:${port}`);