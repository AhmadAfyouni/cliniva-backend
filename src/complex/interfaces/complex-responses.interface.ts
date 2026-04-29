/**
 * Response Type Interfaces for Complex Management Endpoints
 *
 * This file defines all response structures used by the complex management API.
 * All responses follow a consistent structure with bilingual messages.
 *
 * Requirements: 1.1, 2.1, 6.9, 10.9
 */

import { Types } from 'mongoose';
import { Complex } from '../../database/schemas/complex.schema';

/**
 * Bilingual Message Structure
 * Used for all user-facing messages (success and error)
 */
export interface BilingualMessage {
  ar: string;
  en: string;
}

/**
 * Base Success Response
 * All successful API responses extend this structure
 */
export interface BaseSuccessResponse {
  success: true;
  message: BilingualMessage;
}

/**
 * Error Response Structure
 * Used for all error responses with bilingual messages
 *
 * Requirement: 11.3, 11.4, 11.5
 */
export interface ErrorResponse {
  success: false;
  error: {
    code: string;
    message: BilingualMessage;
    details?: any;
  };
}

/**
 * Pagination Metadata
 * Used in all paginated list responses
 *
 * Requirement: 1.1
 */
export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

/**
 * Paginated Response Structure
 * Generic type for paginated list responses
 *
 * Requirement: 1.1
 */
export interface PaginatedResponse<T> extends BaseSuccessResponse {
  data: T[];
  meta: PaginationMeta;
}

/**
 * Capacity Breakdown by Clinic
 * Detailed capacity information for each clinic in a complex
 *
 * Requirement: 2.7, 7.1
 */
export interface ClinicCapacityBreakdown {
  clinicId: string;
  clinicName: string;
  maxDoctors: number;
  maxStaff: number;
  maxPatients: number;
  currentDoctors: number;
  currentStaff: number;
  currentPatients: number;
}

/**
 * Capacity Breakdown Structure
 * Complete capacity information for a complex
 *
 * Requirement: 1.4, 2.6, 2.7, 7.1, 7.2, 7.3, 7.4, 7.5
 */
export interface CapacityBreakdown {
  total: {
    maxDoctors: number;
    maxStaff: number;
    maxPatients: number;
  };
  current: {
    doctors: number;
    staff: number;
    patients: number;
  };
  utilization: {
    doctors: number; // percentage
    staff: number; // percentage
    patients: number; // percentage
  };
  byClinic: ClinicCapacityBreakdown[];
  recommendations?: string[];
}

/**
 * Complex with Calculated Counts
 * Extended complex data with calculated metrics
 * Used in list responses when includeCounts=true
 *
 * Requirement: 1.2, 1.3, 1.4
 */
export interface ComplexWithCounts extends Complex {
  scheduledAppointmentsCount?: number;
  clinicsAssignedCount?: number;
  capacity?: CapacityBreakdown;
}

export interface AssignedClinicSummary {
  no: number;
  clinicId: string;
  name: string;
  PIC?: string | null;
  pic?: string | null;
  personInCharge?: { name: string } | null;
  scheduledAppointmentsCount: number;
  doctors: number;
  status: string;
}

export interface DoctorStaffSummary {
  no: number;
  employeeNumber?: string | null;
  name: string;
  clinic?: string | null;
  userType: string;
  status: string;
}

/**
 * Complex Details Response
 * Complete complex information with all relationships and calculations
 *
 * Requirement: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8
 */
export interface ComplexDetailsResponse extends BaseSuccessResponse {
  data: {
    _id: Types.ObjectId;
    // Basic complex data
    name: string;
    managerName?: string;
    logoUrl?: string;
    website?: string;
    email?: string;
    phoneNumbers?: any[];
    address?: any;
    emergencyContact?: any;
    socialMediaLinks?: any;

    // Business information
    yearEstablished?: number;
    mission?: string;
    vision?: string;
    overview?: string;
    goals?: string;
    ceoName?: string;

    // Legal information
    vatNumber?: string;
    crNumber?: string;
    termsConditionsUrl?: string;
    privacyPolicyUrl?: string;

    // Status management
    status: string;
    personInChargeId?: Types.ObjectId;
    deactivatedAt?: Date;
    deactivatedBy?: Types.ObjectId;
    deactivationReason?: string;

    // Relationships (populated)
    organizationId?: Types.ObjectId;
    subscriptionId: Types.ObjectId;
    ownerId: Types.ObjectId;
    organization?: any;
    subscription?: any;
    owner?: any;
    personInCharge?: any;
    clinics?: any[];
    departments?: any[];

    // Calculated metrics
    scheduledAppointmentsCount: number;
    clinicsAssignedCount: number;
    departmentsCount: number;
    capacity: CapacityBreakdown;
    assignedClinics?: AssignedClinicSummary[];
    doctorStaffList?: DoctorStaffSummary[];

    // Timestamps
    createdAt: Date;
    updatedAt: Date;
  };
}

/**
 * Department Restriction
 * Information about departments that cannot be removed due to clinic linkage
 *
 * Requirement: 4.2, 4.3, 4.4
 */
export interface DepartmentRestriction {
  departmentId: string;
  departmentName: string;
  linkedClinics: Array<{
    clinicId: string;
    clinicName: string;
  }>;
}

/**
 * Update Complex Response
 * Response for complex update operations with optional department restrictions
 *
 * Requirement: 4.1, 4.8
 */
export interface UpdateComplexResponse extends BaseSuccessResponse {
  data: Complex;
  departmentRestrictions?: DepartmentRestriction[];
}

/**
 * Status Change Response
 * Response for complex status change operations with cascading effects
 *
 * Requirement: 6.9
 */
export interface StatusChangeResponse extends BaseSuccessResponse {
  data: {
    complex: Complex;
    servicesDeactivated: number;
    clinicsTransferred?: number;
    appointmentsMarkedForRescheduling?: number;
  };
}

export interface ComplexStatusChangeValidation {
  hasActiveClinics: boolean;
  activeClinicsCount: number;
  hasActiveServices: boolean;
  activeServicesCount: number;
  requiresTransfer: boolean;
  availableTargetComplexes: Array<{
    id: string;
    name: string;
  }>;
  warnings: Array<{
    type: 'clinics' | 'services' | 'appointments' | 'staff';
    message: BilingualMessage;
  }>;
}

export interface ComplexStatusChangeValidationResponse
  extends BaseSuccessResponse {
  data: ComplexStatusChangeValidation;
}

/**
 * Capacity Response
 * Response for capacity calculation endpoint
 *
 * Requirement: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6
 */
export interface CapacityResponse extends BaseSuccessResponse {
  data: CapacityBreakdown;
}

/**
 * Working Hours Conflict
 * Information about working hours conflicts during clinic transfer
 *
 * Requirement: 10.6
 */
export interface WorkingHoursConflict {
  clinicId: string;
  clinicName: string;
  conflictType: string;
  details: string;
}

/**
 * Transfer Response
 * Response for clinic transfer operations with conflict information
 *
 * Requirement: 10.9
 */
export interface TransferResponse extends BaseSuccessResponse {
  data: {
    clinicsTransferred: number;
    staffUpdated: number;
    appointmentsMarkedForRescheduling: number;
    conflicts: WorkingHoursConflict[];
  };
}

/**
 * Simple Success Response
 * Used for operations that don't return data (e.g., delete, remove PIC)
 *
 * Requirement: 5.5, 9.3
 */
export interface SuccessResponse extends BaseSuccessResponse {
  data?: any;
}

/**
 * Complex Response
 * Simple response with complex data
 * Used for create, assign PIC operations
 *
 * Requirement: 3.8, 8.5
 */
export interface ComplexResponse extends BaseSuccessResponse {
  data: Complex;
}
