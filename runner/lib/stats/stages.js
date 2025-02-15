import {
  makeRawStats,
  makeStatsCollection,
  cloneData,
  makeGetters,
  copyProperties,
  rounder,
  arrayGroupBy,
  summarize,
  notUndefined,
} from './helpers.js';
import { makeBlockStats, makeBlockStatsSummary } from './blocks.js';
import {
  makeCycleStats,
  makeCycleStatsKey,
  makeCycleStatsSummary,
} from './cycles.js';

/** @typedef {import("./types.js").BlockStats} BlockStats */
/** @typedef {import("./types.js").CycleStats} CycleStats */
/** @typedef {import("./types.js").CycleStatsCollectionKey} CycleStatsCollectionKey */
/** @typedef {import("./types.js").StageStatsInitData} StageStatsInitData */
/** @typedef {import("./types.js").StageStats} StageStats */

/**
 * @typedef {|
 *   'blocksSummaries' |
 *   'cyclesSummaries' |
 *   'firstBlockHeight' |
 *   'lastBlockHeight' |
 *   'startedAt' |
 *   'readyAt' |
 *   'shutdownAt' |
 *   'endedAt' |
 *   'chainStartedAt' |
 *   'chainReadyAt' |
 *   'clientStartedAt' |
 *   'clientReadyAt' |
 *   'loadgenStartedAt' |
 *   'loadgenReadyAt' |
 * never } RawStageStatsProps
 */

/** @type {import('./helpers.js').RawStatInit<StageStats,RawStageStatsProps>} */
const rawStageStatsInit = {
  blocksSummaries: null,
  cyclesSummaries: null,
  firstBlockHeight: null,
  lastBlockHeight: {
    writeMulti: true,
  },
  startedAt: null,
  readyAt: null,
  shutdownAt: null,
  endedAt: null,
  chainStartedAt: null,
  chainReadyAt: null,
  clientStartedAt: null,
  clientReadyAt: null,
  loadgenStartedAt: null,
  loadgenReadyAt: null,
};

/** @param {BlockStats} blockStats */
const blockSummerTransform = ({
  blockHeight,
  liveMode,
  lag,
  blockDuration,
  chainBlockDuration,
  idleTime,
  cosmosTime,
  swingsetTime,
  processingTime,
  swingsetPercentage,
  processingPercentage,
  deliveries,
  computrons,
}) => ({
  liveMode: liveMode !== undefined ? Number(liveMode) : undefined,
  startBlockHeight: blockHeight,
  endBlockHeight: blockHeight,
  lag,
  blockDuration,
  chainBlockDuration,
  idleTime,
  cosmosTime,
  swingsetTime,
  processingTime,
  swingsetPercentage,
  processingPercentage,
  deliveries,
  computrons,
});

/** @param {CycleStats} cycleStats */
const cyclesSummerTransform = ({ success, blockCount, duration }) => ({
  success: Number(success),
  blockCount: blockCount || 0,
  duration: duration || 0,
});

/**
 * @param {BlockStats[] | undefined} blocks
 */
const generateBlocksSummary = (blocks = []) => {
  const sumData = blocks.map((stats) => ({
    values: blockSummerTransform(stats),
    weight: 1,
  }));

  return makeBlockStatsSummary(summarize(sumData));
};

/**
 * @param {CycleStats[] | undefined} cycles
 */
const generateCyclesSummary = (cycles = []) => {
  const sumData = cycles
    .filter((stats) => stats.success !== undefined)
    .map((stats) => ({
      values: cyclesSummerTransform(stats),
      weight: 1,
    }));

  return makeCycleStatsSummary(summarize(sumData));
};

/**
 * @param {CycleStats[]} allCycles
 */
export const getCyclesSummaries = (allCycles) => {
  /**
   * @type {import('./helpers.js').MakeStatsCollectionReturnType<
   *    string,
   *    import('./types.js').CycleStatsSummary | undefined
   * >}
   */
  const { collection: cyclesSummaries, insert: setCyclesSummary } =
    makeStatsCollection();

  const cyclesByTask = arrayGroupBy(allCycles, ({ task }) => task);

  setCyclesSummary('all', generateCyclesSummary(allCycles));

  for (const [task, taskCycles] of Object.entries(cyclesByTask)) {
    setCyclesSummary(task, generateCyclesSummary(taskCycles));
  }

  return cyclesSummaries;
};

/**
 * @param {BlockStats[]} allBlocks
 */
export const getBlocksSummaries = (allBlocks) => {
  /**
   * @type {import('./helpers.js').MakeStatsCollectionReturnType<
   *    import('./types.js').StageBlocksSummaryType,
   *    import('./types.js').BlockStatsSummary | undefined
   * >}
   */
  const { collection: blocksSummaries, insert: setBlocksSummary } =
    makeStatsCollection();

  const blocksByLiveMode = arrayGroupBy(allBlocks, ({ liveMode }) =>
    String(liveMode),
  );

  const hasShutdownInfo = allBlocks[0].beforeShutdown != null;
  const last100BeforeShutdown = allBlocks
    .filter(({ beforeShutdown }) => !hasShutdownInfo || beforeShutdown)
    .slice(-100);

  setBlocksSummary('all', generateBlocksSummary(allBlocks));
  setBlocksSummary('last100', generateBlocksSummary(last100BeforeShutdown));
  setBlocksSummary('onlyLive', generateBlocksSummary(blocksByLiveMode.true));
  setBlocksSummary(
    'onlyCatchup',
    generateBlocksSummary(blocksByLiveMode.false),
  );

  return blocksSummaries;
};

/**
 * @param {StageStatsInitData} data
 * @returns {StageStats}
 */
export const makeStageStats = (data) => {
  const { savedData, publicProps, privateSetters } =
    makeRawStats(rawStageStatsInit);

  /** @type {import("./helpers.js").MakeStatsCollectionReturnType<number, BlockStats>} */
  const {
    collection: blocks,
    insert: insertBlock,
    getCount: getBlockCount,
  } = makeStatsCollection();

  /** @type {import("./helpers.js").MakeStatsCollectionReturnType<CycleStatsCollectionKey, CycleStats>} */
  const {
    collection: cycles,
    insert: insertCycle,
    getCount: getCycleCount,
  } = makeStatsCollection();

  /** @type {StageStats['newBlock']} */
  const newBlock = (blockData) => {
    const { blockHeight } = blockData;

    assert(blockHeight);

    if (!getBlockCount()) {
      privateSetters.firstBlockHeight(blockHeight);
    }
    privateSetters.lastBlockHeight(blockHeight);
    // eslint-disable-next-line no-use-before-define
    const block = makeBlockStats(blockData, stats);
    insertBlock(blockHeight, block);
    return block;
  };

  /** @type {StageStats['getOrMakeCycle']} */
  const getOrMakeCycle = (cycleData) => {
    const key = makeCycleStatsKey(cycleData);
    let cycle = cycles[key];
    if (!cycle) {
      // eslint-disable-next-line no-use-before-define
      cycle = makeCycleStats(cycleData, stats);
      insertCycle(key, cycle);
    }
    return cycle;
  };

  /** @type {StageStats['recordEnd']} */
  const recordEnd = (time) => {
    privateSetters.endedAt(time);

    privateSetters.cyclesSummaries(
      getCycleCount()
        ? getCyclesSummaries(Object.values(cycles).filter(notUndefined))
        : undefined,
    );
    privateSetters.blocksSummaries(
      getBlockCount()
        ? getBlocksSummaries(Object.values(blocks).filter(notUndefined))
        : undefined,
    );
  };

  const getReadyDuration = () =>
    savedData.startedAt &&
    savedData.readyAt &&
    rounder(savedData.readyAt - savedData.startedAt);

  const getDuration = () =>
    savedData.startedAt &&
    savedData.endedAt &&
    rounder(savedData.endedAt - savedData.startedAt);

  const getChainInitDuration = () =>
    savedData.chainStartedAt &&
    savedData.chainReadyAt &&
    rounder(savedData.chainReadyAt - savedData.chainStartedAt);

  const getClientInitDuration = () =>
    savedData.clientStartedAt &&
    savedData.clientReadyAt &&
    rounder(savedData.clientReadyAt - savedData.clientStartedAt);

  const getLoadgenInitDuration = () =>
    savedData.loadgenStartedAt &&
    savedData.loadgenReadyAt &&
    rounder(savedData.loadgenReadyAt - savedData.loadgenStartedAt);

  const stats = harden(
    copyProperties(
      {
        recordStart: privateSetters.startedAt,
        recordReady: privateSetters.readyAt,
        recordShutdown: privateSetters.shutdownAt,
        recordEnd,
        recordChainStart: privateSetters.chainStartedAt,
        recordChainReady: privateSetters.chainReadyAt,
        recordClientStart: privateSetters.clientStartedAt,
        recordClientReady: privateSetters.clientReadyAt,
        recordLoadgenStart: privateSetters.loadgenStartedAt,
        recordLoadgenReady: privateSetters.loadgenReadyAt,
        newBlock,
        getOrMakeCycle,
      },
      cloneData(data),
      publicProps,
      makeGetters({
        blocks: () => blocks,
        cycles: () => cycles,
        blockCount: getBlockCount,
        cycleCount: getCycleCount,
        readyDuration: getReadyDuration,
        duration: getDuration,
        chainInitDuration: getChainInitDuration,
        clientInitDuration: getClientInitDuration,
        loadgenInitDuration: getLoadgenInitDuration,
      }),
    ),
  );

  return stats;
};
