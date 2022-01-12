import { BaseManager } from ".";
import { DisTubeError, Queue, RepeatMode } from "../..";
import type { DisTubeVoiceEvents, Song } from "../..";
import type { GuildTextBasedChannel, VoiceBasedChannel } from "discord.js";

/**
 * Queue manager
 * @extends BaseManager
 */
export class QueueManager extends BaseManager<Queue> {
  /**
   * Collection of {@link Queue}.
   * @name QueueManager#collection
   * @type {Discord.Collection<string, Queue>}
   */
  /**
   * Create a {@link Queue}
   * @private
   * @param {Discord.BaseGuildVoiceChannel} channel A voice channel
   * @param {Song|Song[]} song First song
   * @param {Discord.BaseGuildTextChannel} textChannel Default text channel
   * @returns {Promise<Queue|true>} Returns `true` if encounter an error
   */
  async create(
    channel: VoiceBasedChannel,
    song: Song[] | Song,
    textChannel?: GuildTextBasedChannel,
  ): Promise<Queue | true> {
    if (this.has(channel.guild.id)) throw new DisTubeError("QUEUE_EXIST");
    const voice = this.voices.create(channel);
    const queue = new Queue(this.distube, voice, song, textChannel);
    await queue.taskQueue.queuing();
    try {
      await voice.join();
      this.#voiceEventHandler(queue);
      this.add(queue.id, queue);
      this.emit("initQueue", queue);
      const err = await this.playSong(queue);
      return err || queue;
    } finally {
      queue.taskQueue.resolve();
    }
  }
  /**
   * Get a Queue from this QueueManager.
   * @method get
   * @memberof QueueManager#
   * @param {GuildIDResolvable} queue Resolvable thing from a guild
   * @returns {Queue?}
   */
  /**
   * Listen to DisTubeVoice events and handle the Queue
   * @private
   * @param {Queue} queue Queue
   */
  #voiceEventHandler(queue: Queue) {
    queue.listeners = {
      disconnect: error => {
        queue.delete();
        this.emit("disconnect", queue);
        if (error) this.emitError(error, queue.textChannel);
      },
      error: error => this.#handlePlayingError(queue, error),
      finish: () => this.#handleSongFinish(queue),
    };
    for (const event of Object.keys(queue.listeners) as (keyof DisTubeVoiceEvents)[]) {
      queue.voice.on(event, queue.listeners[event]);
    }
  }
  /**
   * Handle the queue when a Song finish
   * @private
   * @param {Queue} queue queue
   * @returns {Promise<void>}
   */
  async #handleSongFinish(queue: Queue): Promise<void> {
    this.emit("finishSong", queue, queue.songs[0]);
    await queue.taskQueue.queuing();
    try {
      if (queue.stopped) return;
      if (queue.repeatMode === RepeatMode.QUEUE && !queue.prev) queue.songs.push(queue.songs[0]);
      if (queue.prev) {
        if (queue.repeatMode === RepeatMode.QUEUE) queue.songs.unshift(queue.songs.pop() as Song);
        else queue.songs.unshift(queue.previousSongs.pop() as Song);
      }
      if (queue.songs.length <= 1 && (queue.next || queue.repeatMode === RepeatMode.DISABLED)) {
        if (queue.autoplay) {
          try {
            await queue.addRelatedSong();
          } catch {
            this.emit("noRelated", queue);
          }
        }
        if (queue.songs.length <= 1) {
          if (this.options.leaveOnFinish) queue.voice.leave();
          if (!queue.autoplay) this.emit("finish", queue);
          queue.delete();
          return;
        }
      }
      const emitPlaySong = this.#emitPlaySong(queue);
      if (!queue.prev && (queue.repeatMode !== RepeatMode.SONG || queue.next)) {
        const prev = queue.songs.shift() as Song;
        delete prev.formats;
        delete prev.streamURL;
        if (this.options.savePreviousSongs) queue.previousSongs.push(prev);
        else queue.previousSongs.push({ id: prev.id } as Song);
      }
      queue.next = queue.prev = false;
      queue.beginTime = 0;
      const err = await this.playSong(queue);
      if (!err && emitPlaySong) this.emit("playSong", queue, queue.songs[0]);
    } finally {
      queue.taskQueue.resolve();
    }
  }
  /**
   * Handle error while playing
   * @private
   * @param {Queue} queue queue
   * @param {Error} error error
   */
  #handlePlayingError(queue: Queue, error: Error) {
    const song = queue.songs.shift() as Song;
    try {
      error.name = "PlayingError";
      error.message = `${error.message}\nID: ${song.id}\nName: ${song.name}`;
    } catch {}
    this.emitError(error, queue.textChannel);
    if (queue.songs.length > 0) {
      this.playSong(queue).then(e => {
        if (!e) this.emit("playSong", queue, queue.songs[0]);
      });
    } else {
      queue.stop();
    }
  }

  /**
   * Play a song on voice connection
   * @private
   * @param {Queue} queue The guild queue
   * @returns {Promise<boolean>} error?
   */
  async playSong(queue: Queue): Promise<boolean> {
    if (!queue) return true;
    if (!queue.songs.length) {
      queue.stop();
      return true;
    }
    if (queue.stopped) return false;
    const song = queue.songs[0];
    try {
      const { url, source, formats, streamURL } = song;
      if (source === "youtube" && !formats) song._patchYouTube(await this.handler.getYouTubeInfo(url));
      if (source !== "youtube" && !streamURL) {
        for (const plugin of [...this.distube.extractorPlugins, ...this.distube.customPlugins]) {
          if (await plugin.validate(url)) {
            song.streamURL = await plugin.getStreamURL(url);
            break;
          }
        }
      }
      const stream = this.handler.createStream(queue);
      queue.voice.play(stream);
      song.streamURL = stream.url;
      if (queue.stopped) queue.stop();
      else if (queue.paused) queue.voice.pause();
      return false;
    } catch (e: any) {
      this.#handlePlayingError(queue, e);
      return true;
    }
  }
  /**
   * Whether or not emit playSong event
   * @param {Queue} queue Queue
   * @private
   * @returns {boolean}
   */
  #emitPlaySong(queue: Queue): boolean {
    return (
      !this.options.emitNewSongOnly ||
      (queue.repeatMode === RepeatMode.SONG && queue.next) ||
      (queue.repeatMode !== RepeatMode.SONG && queue.songs[0]?.id !== queue.songs[1]?.id)
    );
  }
}
