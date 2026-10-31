// My Garage (P7: W-GAR-01 master–detail with its tabs, W-GAR-02 records and documents, W-GAR-03 add/edit vehicle,
// C-PLAN-01, C-GARAGE-09, ownership transfers): the view models (model.ts) and the client screens.
export * from './model';
export { GarageScreen } from './garage-screen';
export { VehicleFormScreen } from './vehicle-form';
export { RecordFormScreen } from './record-form';
export { PrintView } from './print-view';
export { OwnershipRequests, TransferAsk } from './transfers';
export { PlanLimitDialog } from './plan-limit';
export { useModelName, useVehicleTitle } from './names';
