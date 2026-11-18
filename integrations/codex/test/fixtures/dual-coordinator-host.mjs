// Self-owned test coordinator, never creates header UI or native input.
import {startDualCoordinator} from '../../lib/dual-coordinator.js'
const coordinator=await startDualCoordinator({testNamespace:process.argv[2],onMembers:async()=>{}})
process.send({endpoint:coordinator.endpoint,scope:coordinator.scope,statePath:coordinator.statePath,guardianPid:coordinator.guardianPid})
