import { Config } from '@remotion/cli/config'

Config.setVideoImageFormat('png')
Config.setOverwriteOutput(true)
Config.setConcurrency(3)
// the 1440p render with an uncapped frame cache stalled on a machine already using swap
Config.setOffthreadVideoCacheSizeInBytes(1_500_000_000)
