import { IPlatformAdapter } from '../types/platform';

export class FileStorage {
  private basePath: string;

  constructor(private platform: IPlatformAdapter) {
    // Resolve base path, e.g. .obsidian/plugins/obsidian-mentat
    this.basePath = `${this.platform.getConfigDir()}/plugins/obsidian-mentat`;
  }

  /**
   * Get full path inside the plugin directory
   */
  private getFullPath(relativePath: string): string {
    const cleanRelativePath = relativePath.startsWith('/')
      ? relativePath.slice(1)
      : relativePath;
    return `${this.basePath}/${cleanRelativePath}`;
  }

  /**
   * Check if a file or directory exists
   */
  async exists(relativePath: string): Promise<boolean> {
    const fullPath = this.getFullPath(relativePath);
    return await this.platform.exists(fullPath);
  }

  /**
   * Read file content
   */
  async read(relativePath: string): Promise<string> {
    const fullPath = this.getFullPath(relativePath);
    return await this.platform.read(fullPath);
  }

  /**
   * Write file content, automatically ensuring parent directories exist
   */
  async write(relativePath: string, data: string): Promise<void> {
    const fullPath = this.getFullPath(relativePath);
    
    // Ensure parent directory exists
    const parts = relativePath.split('/');
    if (parts.length > 1) {
      const parentDir = parts.slice(0, -1).join('/');
      await this.ensureDirectory(parentDir);
    }

    await this.platform.write(fullPath, data);
  }

  /**
   * Delete a file
   */
  async delete(relativePath: string): Promise<void> {
    const fullPath = this.getFullPath(relativePath);
    if (await this.platform.exists(fullPath)) {
      await this.platform.delete(fullPath);
    }
  }

  /**
   * Ensure directory and its parent directories exist
   */
  async ensureDirectory(relativePath: string): Promise<void> {
    const parts = relativePath.split('/').filter(Boolean);
    let currentRelativePath = '';

    for (const part of parts) {
      currentRelativePath = currentRelativePath
        ? `${currentRelativePath}/${part}`
        : part;
      
      const fullPath = this.getFullPath(currentRelativePath);
      if (!(await this.platform.exists(fullPath))) {
        try {
          await this.platform.mkdir(fullPath);
        } catch (error) {
          // If folder creation fails because it already exists due to concurrency, ignore
          if (!(await this.platform.exists(fullPath))) {
            throw error;
          }
        }
      }
    }
  }

  /**
   * List files in a relative directory
   */
  async list(relativePath: string): Promise<string[]> {
    const fullPath = this.getFullPath(relativePath);
    if (!(await this.platform.exists(fullPath))) {
      return [];
    }

    const result = await this.platform.list(fullPath);
    // Return relative paths from the perspective of the basePath/relativePath
    return result.files.map(file => {
      // Extract the filename after the full path prefix
      return file.replace(`${this.basePath}/`, '');
    });
  }
}
