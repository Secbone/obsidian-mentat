// Skill Load Cache - Caches loaded skill details to avoid redundant loads

/**
 * Cache entry
 */
interface CacheEntry {
  details: string;
  timestamp: number;
}

/**
 * Skill Load Cache - manages caching of skill details
 * Implements TTL (time-to-live) and optional LRU eviction
 */
export class SkillLoadCache {
  private cache = new Map<string, CacheEntry>();
  private ttl: number; // Time to live in milliseconds
  private maxSize: number; // Maximum cache size

  constructor(ttl: number = 3600000, maxSize: number = 100) {
    // Default: 1 hour TTL, max 100 entries
    this.ttl = ttl;
    this.maxSize = maxSize;
  }

  /**
   * Get skill details from cache
   * Returns null if not found or expired
   */
  get(skillName: string): string | null {
    const entry = this.cache.get(skillName);

    if (!entry) {
      return null;
    }

    // Check if expired
    if (Date.now() - entry.timestamp > this.ttl) {
      this.cache.delete(skillName);
      return null;
    }

    return entry.details;
  }

  /**
   * Set skill details in cache
   * Implements LRU eviction if cache is full
   */
  set(skillName: string, details: string): void {
    // Evict if cache is full
    if (this.cache.size >= this.maxSize && !this.cache.has(skillName)) {
      this.evictOldest();
    }

    this.cache.set(skillName, {
      details,
      timestamp: Date.now()
    });
  }

  /**
   * Check if a skill is cached and not expired
   */
  has(skillName: string): boolean {
    return this.get(skillName) !== null;
  }

  /**
   * Clear a specific skill from cache
   */
  delete(skillName: string): boolean {
    return this.cache.delete(skillName);
  }

  /**
   * Clear all entries from cache
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Get cache statistics
   */
  getStats(): {
    size: number;
    maxSize: number;
    ttl: number;
    hitRate?: number;
  } {
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      ttl: this.ttl
    };
  }

  /**
   * Evict expired entries
   */
  evictExpired(): number {
    const now = Date.now();
    let evicted = 0;

    for (const [skillName, entry] of this.cache.entries()) {
      if (now - entry.timestamp > this.ttl) {
        this.cache.delete(skillName);
        evicted++;
      }
    }

    return evicted;
  }

  /**
   * Evict the oldest entry (LRU)
   */
  private evictOldest(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, entry] of this.cache.entries()) {
      if (entry.timestamp < oldestTime) {
        oldestTime = entry.timestamp;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.cache.delete(oldestKey);
    }
  }

  /**
   * Set TTL (time to live)
   */
  setTTL(ttl: number): void {
    this.ttl = ttl;
  }

  /**
   * Set max cache size
   */
  setMaxSize(maxSize: number): void {
    this.maxSize = maxSize;
    // Evict if current size exceeds new max
    while (this.cache.size > maxSize) {
      this.evictOldest();
    }
  }
}
