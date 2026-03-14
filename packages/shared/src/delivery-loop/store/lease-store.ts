/**
 * Lease store — re-exports from existing lease module
 * with v2 naming convention.
 */
export {
  acquireSdlcLoopLease as acquireLease,
  releaseSdlcLoopLease as releaseLease,
  refreshSdlcLoopLease as refreshLease,
} from "../../model/delivery-loop/lease";

export type {
  SdlcLoopLeaseAcquireResult as LeaseAcquireResult,
  SdlcLoopLeaseRefreshResult as LeaseRefreshResult,
} from "../../model/delivery-loop/lease";
