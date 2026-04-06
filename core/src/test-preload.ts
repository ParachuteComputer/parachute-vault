// Preload for tests: enable sqlite-vec on macOS before any Database opens
import { useHomebrewSQLiteIfNeeded } from "./embeddings.js";
useHomebrewSQLiteIfNeeded();
