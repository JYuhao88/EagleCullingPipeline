import { parentPort, workerData } from "node:worker_threads";
import { clusterByEmbedding } from "./embedding.js";

parentPort.postMessage(clusterByEmbedding(workerData.items, workerData.threshold));
parentPort.close();
