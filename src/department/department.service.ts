import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Department } from '../database/schemas/department.schema';
import { ComplexDepartment } from '../database/schemas/complex-department.schema';
import { Clinic } from '../database/schemas/clinic.schema';
import { Service } from '../database/schemas/service.schema';
import {
  CreateDepartmentDto,
  AssignDepartmentsDto,
  UpdateDepartmentDto,
} from './dto/create-department.dto';
import {
  DeleteResult,
  CanDeleteResult,
  LinkedClinicDto,
  CheckDependenciesResult,
  DeactivateWithTransferResult,
} from './dto/delete-response.dto';
import {
  DEPARTMENT_ERROR_CODES,
  DEPARTMENT_ERROR_MESSAGES,
  DEPARTMENT_SUCCESS_MESSAGES,
  buildCannotDeleteReason,
  buildDeletionRecommendations,
} from './constants';
import {
  buildTenantFilter,
  TenantUser,
} from '../common/utils/tenant-scope.util';

/**
 * Internal interface for clinic data with populated complex
 * Used for type safety in deletion validation queries
 */
interface LinkedClinicData {
  _id: Types.ObjectId;
  name: string;
  complexId?: {
    _id: Types.ObjectId;
    name: string;
  };
}

@Injectable()
export class DepartmentService {
  private readonly logger = new Logger(DepartmentService.name);

  constructor(
    @InjectModel('Department')
    private readonly departmentModel: Model<Department>,
    @InjectModel('ComplexDepartment')
    private readonly complexDepartmentModel: Model<ComplexDepartment>,
    @InjectModel('Clinic')
    private readonly clinicModel: Model<Clinic>,
    @InjectModel('Service')
    private readonly serviceModel: Model<Service>,
  ) {}

  /**
   * Create a new department
   * @param createDepartmentDto - Department creation data
   * @param creatingUser - Authenticated user creating the department (provides tenant scope).
   *   Optional for backward compatibility with the onboarding flow which creates
   *   departments before the user has a full JWT scope.
   * @returns Created department document
   * @throws BadRequestException if department name already exists
   */
  async createDepartment(
    createDepartmentDto: CreateDepartmentDto,
    creatingUser?: TenantUser,
  ): Promise<Department> {
    // Check if department already exists (scoped to the same subscription when user is provided)
    const tenantFilter = creatingUser ? buildTenantFilter(creatingUser) : {};
    const existingDepartment = await this.departmentModel.findOne({
      name: createDepartmentDto.name,
      ...tenantFilter,
    });

    if (existingDepartment) {
      throw new BadRequestException({
        message: DEPARTMENT_ERROR_MESSAGES.NAME_EXISTS,
        code: DEPARTMENT_ERROR_CODES.NAME_EXISTS,
      });
    }

    const department = new this.departmentModel({
      ...createDepartmentDto,
      subscriptionId:
        creatingUser?.subscriptionId
          ? new Types.ObjectId(creatingUser.subscriptionId)
          : undefined,
      complexId:
        creatingUser?.complexId
          ? new Types.ObjectId(creatingUser.complexId)
          : undefined,
    });
    return await department.save();
  }

  /**
   * Get all departments
   * @param requestingUser - Authenticated user (used to scope results to tenant)
   * @returns Array of department documents scoped to the requesting user's subscription
   */
  async getAllDepartments(requestingUser?: TenantUser): Promise<Department[]> {
    const tenantFilter = requestingUser ? buildTenantFilter(requestingUser) : {};
    return await this.departmentModel.find(tenantFilter).exec();
  }

  /**
   * Get a single department by ID
   * @param departmentId - Department ID
   * @returns Department document
   * @throws NotFoundException if department not found
   */
  async getDepartment(departmentId: string): Promise<Department> {
    const department = await this.departmentModel.findById(departmentId);
    if (!department) {
      throw new NotFoundException({
        message: DEPARTMENT_ERROR_MESSAGES.NOT_FOUND,
        code: DEPARTMENT_ERROR_CODES.NOT_FOUND,
      });
    }
    return department;
  }

  /**
   * Update a department
   * @param departmentId - Department ID
   * @param updateDepartmentDto - Department update data
   * @returns Updated department document
   * @throws NotFoundException if department not found
   * @throws BadRequestException if new name already exists
   */
  async updateDepartment(
    departmentId: string,
    updateDepartmentDto: UpdateDepartmentDto,
  ): Promise<Department> {
    // Validate department exists
    await this.validateDepartmentExists(departmentId);

    // If name is being updated, check for uniqueness
    if (updateDepartmentDto.name) {
      const existingDepartment = await this.departmentModel.findOne({
        name: updateDepartmentDto.name,
        _id: { $ne: departmentId },
      });

      if (existingDepartment) {
        throw new BadRequestException({
          message: DEPARTMENT_ERROR_MESSAGES.NAME_EXISTS,
          code: DEPARTMENT_ERROR_CODES.NAME_EXISTS,
        });
      }
    }

    // Update department
    const updatedDepartment = await this.departmentModel
      .findByIdAndUpdate(departmentId, updateDepartmentDto, {
        new: true,
        runValidators: true,
      })
      .exec();

    if (!updatedDepartment) {
      throw new NotFoundException({
        message: DEPARTMENT_ERROR_MESSAGES.NOT_FOUND,
        code: DEPARTMENT_ERROR_CODES.NOT_FOUND,
      });
    }

    return updatedDepartment;
  }

  /**
   * Create a relationship between a complex and a department
   * @param complexId - Complex ID
   * @param departmentId - Department ID
   * @returns Created ComplexDepartment document
   * @throws BadRequestException if relationship already exists
   */
  async createComplexDepartment(
    complexId: string,
    departmentId: string,
  ): Promise<ComplexDepartment> {
    // Check if complex-department relationship already exists
    const existing = await this.complexDepartmentModel.findOne({
      complexId: new Types.ObjectId(complexId),
      departmentId: new Types.ObjectId(departmentId),
    });

    if (existing) {
      throw new BadRequestException(
        'Department already assigned to this complex',
      );
    }

    const complexDepartment = new this.complexDepartmentModel({
      complexId: new Types.ObjectId(complexId),
      departmentId: new Types.ObjectId(departmentId),
      isActive: true,
    });

    return await complexDepartment.save();
  }

  /**
   * Assign multiple departments to a complex
   * @param complexId - Complex ID
   * @param assignDto - DTO containing array of department IDs
   * @returns Array of created ComplexDepartment documents
   */
  async assignDepartmentsToComplex(
    complexId: string,
    assignDto: AssignDepartmentsDto,
  ): Promise<ComplexDepartment[]> {
    const results: ComplexDepartment[] = [];

    for (const departmentId of assignDto.departmentIds) {
      try {
        const complexDepartment = await this.createComplexDepartment(
          complexId,
          departmentId,
        );
        results.push(complexDepartment);
      } catch (error) {
        if (error.message.includes('already assigned')) {
          // Skip if already assigned
          continue;
        }
        throw error;
      }
    }

    return results;
  }

  /**
   * Get all departments assigned to a specific complex
   * @param complexId - Complex ID
   * @param requestingUser - Authenticated user (used to scope results to tenant)
   * @returns Array of department documents
   */
  async getDepartmentsByComplex(
    complexId: string,
    requestingUser?: TenantUser,
  ): Promise<Department[]> {
    const complexDepartments = await this.complexDepartmentModel
      .find({
        complexId: new Types.ObjectId(complexId),
        isActive: true,
      })
      .populate({
        path: 'departmentId',
        // Tenant scope is enforced by the complexId join — complexes are tenant-scoped.
        // Filtering by subscriptionId here breaks departments created during onboarding
        // that were not stamped with a subscriptionId at creation time.
        match: { deletedAt: { $exists: false } },
      })
      .exec();

    return complexDepartments
      .filter((cd) => cd.departmentId !== null)
      .map((cd) => cd.departmentId as unknown as Department);
  }

  /**
   * Get all ComplexDepartment relationships for a specific complex
   * @param complexId - Complex ID
   * @returns Array of ComplexDepartment documents with populated department data
   */
  async getComplexDepartmentsByComplex(
    complexId: string,
  ): Promise<ComplexDepartment[]> {
    return await this.complexDepartmentModel
      .find({
        complexId: new Types.ObjectId(complexId),
        isActive: true,
      })
      .populate('departmentId', 'name description status')
      .exec();
  }

  /**
   * Get a single ComplexDepartment relationship by ID
   * @param complexDepartmentId - ComplexDepartment ID
   * @returns ComplexDepartment document with populated department data, or null if not found
   */
  async getComplexDepartmentById(
    complexDepartmentId: string,
  ): Promise<ComplexDepartment | null> {
    return await this.complexDepartmentModel
      .findById(complexDepartmentId)
      .populate('departmentId', 'name description status')
      .exec();
  }

  /**
   * Find a ComplexDepartment by either its own _id (junction record)
   * or by the underlying Department document _id (departmentId field).
   * Accepts an optional complexId to narrow the fallback search.
   */
  async findComplexDepartmentByAnyId(
    id: string,
    complexId?: string,
  ): Promise<ComplexDepartment | null> {
    const byJunctionId = await this.complexDepartmentModel
      .findById(id)
      .populate('departmentId', 'name description status')
      .exec();
    if (byJunctionId) return byJunctionId;

    const query: any = { departmentId: id };
    if (complexId) query.complexId = complexId;

    return await this.complexDepartmentModel
      .findOne(query)
      .populate('departmentId', 'name description status')
      .exec();
  }

  /**
   * Validate that a department exists and return it
   *
   * This method performs validation to ensure a department exists in the database
   * before performing operations on it. It also validates the ObjectId format.
   *
   * @param departmentId - Department ID to validate (must be valid MongoDB ObjectId)
   * @returns Department document if found
   * @throws BadRequestException if departmentId is not a valid ObjectId
   * @throws NotFoundException if department not found in database
   *
   * @private
   * @example
   * const department = await this.validateDepartmentExists('507f1f77bcf86cd799439011');
   */
  private async validateDepartmentExists(
    departmentId: string,
  ): Promise<Department> {
    // Validate ObjectId format before querying database
    if (!Types.ObjectId.isValid(departmentId)) {
      throw new BadRequestException({
        message: {
          ar: 'معرف القسم غير صالح',
          en: 'Invalid department ID format',
        },
        code: 'INVALID_ID',
      });
    }

    const department = await this.departmentModel.findById(departmentId);

    if (!department) {
      throw new NotFoundException({
        message: DEPARTMENT_ERROR_MESSAGES.NOT_FOUND,
        code: DEPARTMENT_ERROR_CODES.NOT_FOUND,
      });
    }

    return department;
  }

  /**
   * Get ComplexDepartment IDs for a given department
   *
   * Retrieves all active ComplexDepartment junction records that link
   * the specified department to complexes. This is used to find all
   * clinics that might be using this department.
   *
   * @param departmentId - Department ID (must be valid MongoDB ObjectId)
   * @returns Array of ComplexDepartment ObjectIds (empty array if none found)
   *
   * @private
   * @example
   * const complexDeptIds = await this.getComplexDepartmentIds('507f1f77bcf86cd799439011');
   * // Returns: [ObjectId('...'), ObjectId('...')]
   */
  private async getComplexDepartmentIds(
    departmentId: string,
  ): Promise<Types.ObjectId[]> {
    const complexDepartments = await this.complexDepartmentModel
      .find({
        departmentId: new Types.ObjectId(departmentId),
        isActive: true,
      })
      .select('_id')
      .lean();

    return complexDepartments.map((cd) => cd._id as Types.ObjectId);
  }

  /**
   * Get clinics linked to ComplexDepartment IDs
   *
   * Queries the Clinic collection to find all clinics that are using
   * the specified ComplexDepartment IDs. Excludes deleted clinics and
   * populates complex information for detailed error messages.
   *
   * Query is optimized with:
   * - `.select()` to limit returned fields
   * - `.lean()` for read-only performance
   * - `.populate()` only for required complex name
   *
   * @param complexDeptIds - Array of ComplexDepartment IDs to check
   * @returns Array of linked clinics with complex information (empty if none found)
   *
   * @private
   * @example
   * const linkedClinics = await this.getLinkedClinics([ObjectId('...')]);
   * // Returns: [{ _id: ObjectId, name: 'Clinic A', complexId: { _id: ObjectId, name: 'Complex 1' } }]
   */
  private async getLinkedClinics(
    departmentId: string,
    complexDeptIds: Types.ObjectId[],
  ): Promise<LinkedClinicData[]> {
    const referenceIds = new Map<string, Types.ObjectId>();
    if (Types.ObjectId.isValid(departmentId)) {
      const departmentObjectId = new Types.ObjectId(departmentId);
      referenceIds.set(departmentObjectId.toString(), departmentObjectId);
    }
    for (const complexDeptId of complexDeptIds) {
      referenceIds.set(complexDeptId.toString(), complexDeptId);
    }

    if (referenceIds.size === 0) {
      return [];
    }

    const linkedClinics = await this.clinicModel
      .find({
        complexDepartmentId: { $in: Array.from(referenceIds.values()) },
        deletedAt: null,
      })
      .populate('complexId', 'name')
      .select('_id name complexId')
      .lean<LinkedClinicData[]>();

    return linkedClinics;
  }

  /**
   * Get count of services linked to ComplexDepartment IDs
   *
    * Services are now scoped by complex (`complexId`) and no longer linked
    * directly to complex departments.
   *
   * Handles edge cases:
   * - Returns 0 if no ComplexDepartment IDs provided
   * - Returns 0 if service model is not available (optional dependency)
   * - Returns 0 if service collection doesn't exist yet
   *
   * @param complexDeptIds - Array of ComplexDepartment IDs to check
   * @returns Count of linked services (0 if none found or service collection unavailable)
   *
   * @private
   * @example
   * const serviceCount = await this.getLinkedServicesCount([ObjectId('...')]);
   * // Returns: 5
   */
  private async getLinkedServicesCount(
    complexDeptIds: Types.ObjectId[],
  ): Promise<number> {
    void complexDeptIds;
    return 0;
  }

  /**
   * Format linked clinic data to DTO format
   *
   * Transforms internal database clinic data structure to the public
   * DTO format used in API responses. Handles missing complex data
   * gracefully by providing 'Unknown' as fallback.
   *
   * @param linkedClinics - Array of linked clinic data from database query
   * @returns Array of formatted LinkedClinicDto objects for API response
   *
   * @private
   * @example
   * const formatted = this.formatLinkedClinics(dbClinics);
   * // Returns: [{ clinicId: '507f...', clinicName: 'Clinic A', complexName: 'Complex 1', complexId: '507f...' }]
   */
  private formatLinkedClinics(
    linkedClinics: LinkedClinicData[],
  ): LinkedClinicDto[] {
    return linkedClinics.map((c) => ({
      clinicId: c._id.toString(),
      clinicName: c.name,
      complexName: c.complexId?.name || 'Unknown',
      complexId: c.complexId?._id?.toString(),
    }));
  }

  /**
   * Build response for can-delete check
   *
   * Constructs a comprehensive response indicating whether a department
   * can be safely deleted, along with detailed information about any
   * blocking linkages.
   *
   * Response includes:
   * - canDelete flag (true if no linkages exist)
   * - Bilingual reason message (if deletion blocked)
   * - List of linked clinics with details (if applicable)
   * - Count of linked services (if applicable)
   * - Bilingual recommendations for user action (if deletion blocked)
   *
   * @param linkedClinics - Array of clinics linked to the department
   * @param linkedServices - Count of services linked to the department
   * @returns CanDeleteResult with deletion eligibility information
   *
   * @private
   * @example
   * const result = this.buildCanDeleteResponse([], 0);
   * // Returns: { success: true, data: { canDelete: true } }
   *
   * @example
   * const result = this.buildCanDeleteResponse([clinic1, clinic2], 5);
   * // Returns: { success: true, data: { canDelete: false, reason: {...}, linkedClinics: [...], linkedServices: 5, recommendations: {...} } }
   */
  private buildCanDeleteResponse(
    linkedClinics: LinkedClinicData[],
    linkedServices: number,
  ): CanDeleteResult {
    const hasLinkedClinics = linkedClinics.length > 0;
    const hasLinkedServices = linkedServices > 0;
    const canDelete = !hasLinkedClinics && !hasLinkedServices;

    if (canDelete) {
      return {
        success: true,
        data: {
          canDelete: true,
        },
      };
    }

    // Build reason message using helper function
    const reason = buildCannotDeleteReason(
      linkedClinics.length,
      linkedServices,
    );

    // Build recommendations using helper function
    const recommendations = buildDeletionRecommendations(
      linkedClinics.length,
      linkedServices,
    );

    // Format linked clinics using helper method
    const formattedClinics = this.formatLinkedClinics(linkedClinics);

    return {
      success: true,
      data: {
        canDelete: false,
        reason,
        linkedClinics: formattedClinics,
        linkedServices: hasLinkedServices ? linkedServices : undefined,
        recommendations,
      },
    };
  }

  /**
   * Delete a department with validation
   *
   * Performs comprehensive validation before deleting a department to ensure
   * data integrity. Implements Business Rule BZR-36 which prevents deletion
   * of departments that are linked to clinics or have services.
   *
   * Validation steps:
   * 1. Verify department exists (throws NotFoundException if not found)
   * 2. Check for linked clinics via ComplexDepartment relationships
   * 3. Check for linked services
   * 4. Delete department if no linkages exist
   *
   * @param departmentId - Department ID to delete (must be valid MongoDB ObjectId)
   * @returns DeleteResult with bilingual success message
   *
   * @throws NotFoundException if department not found (DEPARTMENT_003)
   * @throws BadRequestException if department is linked to clinics (DEPARTMENT_001)
   * @throws BadRequestException if department has services (DEPARTMENT_002)
   * @throws BadRequestException for unexpected errors
   *
   * @example
   * const result = await service.deleteDepartment('507f1f77bcf86cd799439011');
   * // Returns: { success: true, message: { ar: '...', en: '...' } }
   *
   * @example
   * // Throws BadRequestException with linked clinics details
   * await service.deleteDepartment('linked-department-id');
   */
  async deleteDepartment(departmentId: string): Promise<DeleteResult> {
    try {
      // Step 1: Validate department exists
      await this.validateDepartmentExists(departmentId);

      // Step 2: Get ComplexDepartment IDs
      const complexDeptIds = await this.getComplexDepartmentIds(departmentId);

      // Step 3: Check clinic linkage
      const linkedClinics = await this.getLinkedClinics(
        departmentId,
        complexDeptIds,
      );

      if (linkedClinics.length > 0) {
        const formattedClinics = this.formatLinkedClinics(linkedClinics);

        this.logger.warn(
          `Department deletion blocked: ${departmentId} - linked to ${linkedClinics.length} clinics`,
        );

        throw new BadRequestException({
          message: DEPARTMENT_ERROR_MESSAGES.LINKED_TO_CLINICS,
          code: DEPARTMENT_ERROR_CODES.LINKED_TO_CLINICS,
          linkedClinics: formattedClinics,
          linkedClinicsCount: linkedClinics.length,
        });
      }

      // Step 4: Check service linkage
      const linkedServices = await this.getLinkedServicesCount(complexDeptIds);

      if (linkedServices > 0) {
        this.logger.warn(
          `Department deletion blocked: ${departmentId} - has ${linkedServices} services`,
        );

        throw new BadRequestException({
          message: DEPARTMENT_ERROR_MESSAGES.HAS_SERVICES,
          code: DEPARTMENT_ERROR_CODES.HAS_SERVICES,
          linkedServices,
        });
      }

      // Step 5: Safe to delete
      await this.departmentModel.findByIdAndDelete(departmentId);

      this.logger.log(`Department deleted successfully: ${departmentId}`);

      return {
        success: true,
        message: DEPARTMENT_SUCCESS_MESSAGES.DELETED,
      };
    } catch (error) {
      // Re-throw known exceptions
      if (
        error instanceof NotFoundException ||
        error instanceof BadRequestException
      ) {
        throw error;
      }

      // Handle unexpected errors
      this.logger.error(
        `Unexpected error deleting department ${departmentId}:`,
        error.stack,
      );

      throw new BadRequestException({
        message: {
          ar: 'حدث خطأ أثناء حذف القسم',
          en: 'An error occurred while deleting the department',
        },
      });
    }
  }

  /**
   * Check if a department can be deleted
   *
   * Performs a read-only check to determine if a department can be safely
   * deleted without violating data integrity constraints. This endpoint is
   * designed for frontend UI to disable delete buttons and show tooltips.
   *
   * Returns comprehensive information including:
   * - Whether deletion is allowed (canDelete flag)
   * - Bilingual reason if deletion is blocked
   * - List of linked clinics with details
   * - Count of linked services
   * - Bilingual recommendations for user action
   *
   * @param departmentId - Department ID to check (must be valid MongoDB ObjectId)
   * @returns CanDeleteResult with deletion eligibility information
   *
   * @throws NotFoundException if department not found (DEPARTMENT_003)
   * @throws BadRequestException for unexpected errors
   *
   * @example
   * const result = await service.canDeleteDepartment('507f1f77bcf86cd799439011');
   * // Returns: { success: true, data: { canDelete: true } }
   *
   * @example
   * // Returns detailed information about blocking linkages
   * const result = await service.canDeleteDepartment('linked-department-id');
   * // Returns: { success: true, data: { canDelete: false, reason: {...}, linkedClinics: [...], ... } }
   */
  async canDeleteDepartment(departmentId: string): Promise<CanDeleteResult> {
    try {
      // Step 1: Validate department exists
      await this.validateDepartmentExists(departmentId);

      // Step 2: Get ComplexDepartment IDs
      const complexDeptIds = await this.getComplexDepartmentIds(departmentId);

      // Step 3: Get linked clinics
      const linkedClinics = await this.getLinkedClinics(
        departmentId,
        complexDeptIds,
      );

      // Step 4: Get linked services count
      const linkedServices = await this.getLinkedServicesCount(complexDeptIds);

      // Step 5: Build response
      return this.buildCanDeleteResponse(linkedClinics, linkedServices);
    } catch (error) {
      // Re-throw known exceptions
      if (error instanceof NotFoundException) {
        throw error;
      }

      // Handle unexpected errors
      this.logger.error(
        `Unexpected error checking can-delete for department ${departmentId}:`,
        error.stack,
      );

      throw new BadRequestException({
        message: {
          ar: 'حدث خطأ أثناء التحقق من إمكانية حذف القسم',
          en: 'An error occurred while checking if department can be deleted',
        },
      });
    }
  }

  /**
   * Check dependencies for a department
   *
   * Checks if a department has active clinics linked to it. This endpoint
   * provides information about clinics using the department before attempting
   * deactivation or transfer operations.
   *
   * Returns comprehensive information including:
   * - Whether department has active clinics (hasActiveClinics flag)
   * - Count of active clinics using this department
   * - List of clinics with details (clinic name, complex name, IDs)
   *
   * @param departmentId - Department ID to check (must be valid MongoDB ObjectId)
   * @returns CheckDependenciesResult with dependencies information
   *
   * @throws NotFoundException if department not found (DEPARTMENT_003)
   * @throws BadRequestException for unexpected errors
   *
   * @example
   * const result = await service.checkDependencies('507f1f77bcf86cd799439011');
   * // Returns: { success: true, data: { hasActiveClinics: true, count: 3, clinics: [...] }, message: {...} }
   */
  async checkDependencies(
    departmentId: string,
  ): Promise<CheckDependenciesResult> {
    try {
      // Step 1: Validate department exists
      await this.validateDepartmentExists(departmentId);

      // Step 2: Get ComplexDepartment IDs
      const complexDeptIds = await this.getComplexDepartmentIds(departmentId);

      // Step 3: Get linked clinics
      const linkedClinics = await this.getLinkedClinics(
        departmentId,
        complexDeptIds,
      );

      // Step 4: Format linked clinics
      const formattedClinics = this.formatLinkedClinics(linkedClinics);

      // Step 5: Build response
      return {
        success: true,
        data: {
          hasActiveClinics: linkedClinics.length > 0,
          count: linkedClinics.length,
          clinics: formattedClinics,
        },
        message: {
          ar: 'تم التحقق من التبعيات بنجاح',
          en: 'Dependencies checked successfully',
        },
      };
    } catch (error) {
      // Re-throw known exceptions
      if (error instanceof NotFoundException) {
        throw error;
      }

      // Handle unexpected errors
      this.logger.error(
        `Unexpected error checking dependencies for department ${departmentId}:`,
        error.stack,
      );

      throw new BadRequestException({
        message: {
          ar: 'حدث خطأ أثناء التحقق من التبعيات',
          en: 'An error occurred while checking dependencies',
        },
      });
    }
  }

  /**
   * Deactivate department with clinic transfer
   *
   * Deactivates a department and transfers all its clinics to a target department.
   * This operation ensures that clinics are not left without a department assignment
   * when a department is deactivated.
   *
   * Process:
   * 1. Validate source department exists and is active
   * 2. Validate target department exists and is active
   * 3. Get all ComplexDepartment relationships for source department
   * 4. Get all clinics linked to source department
   * 5. For each clinic, find the corresponding ComplexDepartment ID in target department
   * 6. Update clinics to use target department's ComplexDepartment ID
   * 7. Update source department status to 'inactive'
   * 8. Log audit trail
   *
   * @param departmentId - Source department ID to deactivate
   * @param targetDepartmentId - Target department ID to transfer clinics to
   * @returns DeactivateWithTransferResult with success message and transfer count
   *
   * @throws NotFoundException if source or target department not found
   * @throws BadRequestException if source department is already inactive
   * @throws BadRequestException if target department is inactive
   * @throws BadRequestException if target department doesn't have matching complex assignments
   *
   * @example
   * const result = await service.deactivateWithTransfer('source-id', 'target-id');
   * // Returns: { success: true, message: {...}, clinicsTransferred: 3 }
   */
  async deactivateWithTransfer(
    departmentId: string,
    targetDepartmentId: string,
  ): Promise<DeactivateWithTransferResult> {
    try {
      // Step 1: Validate source department exists
      const sourceDepartment = await this.validateDepartmentExists(departmentId);

      // Check if source department is already inactive
      if (sourceDepartment.status === 'inactive') {
        throw new BadRequestException({
          message: DEPARTMENT_ERROR_MESSAGES.DEPARTMENT_INACTIVE,
          code: DEPARTMENT_ERROR_CODES.DEPARTMENT_INACTIVE,
        });
      }

      // Step 2: Validate target department exists and is active
      const targetDepartment = await this.validateDepartmentExists(
        targetDepartmentId,
      );

      if (targetDepartment.status === 'inactive') {
        throw new BadRequestException({
          message: DEPARTMENT_ERROR_MESSAGES.TARGET_DEPARTMENT_INACTIVE,
          code: DEPARTMENT_ERROR_CODES.TARGET_DEPARTMENT_INACTIVE,
        });
      }

      // Step 3: Get ComplexDepartment IDs for source department
      const sourceComplexDeptIds =
        await this.getComplexDepartmentIds(departmentId);

      // Step 4: Get all clinics linked to source department
      const clinicsToTransfer = await this.getLinkedClinics(
        departmentId,
        sourceComplexDeptIds,
      );

      let clinicsTransferred = 0;

      if (clinicsToTransfer.length > 0) {
        // Step 5: Transfer clinics to target department
        // For each clinic, find the ComplexDepartment ID for target department in same complex
        for (const clinic of clinicsToTransfer) {
          const complexId = clinic.complexId?._id;

          if (!complexId) {
            this.logger.warn(
              `Clinic ${clinic._id} has no complex assigned, skipping transfer`,
            );
            continue;
          }

          // Find the ComplexDepartment for target department in this complex
          const targetComplexDept = await this.complexDepartmentModel.findOne({
            complexId: complexId,
            departmentId: new Types.ObjectId(targetDepartmentId),
            isActive: true,
          });

          if (!targetComplexDept) {
            // If target department is not assigned to this complex, create the assignment
            const newComplexDept = new this.complexDepartmentModel({
              complexId: complexId,
              departmentId: new Types.ObjectId(targetDepartmentId),
              isActive: true,
            });
            await newComplexDept.save();

            // Update clinic to use new ComplexDepartment
            await this.clinicModel.updateOne(
              { _id: clinic._id },
              { complexDepartmentId: newComplexDept._id },
            );

            this.logger.log(
              `Created new ComplexDepartment assignment and transferred clinic ${clinic._id} from department ${departmentId} to ${targetDepartmentId}`,
            );
          } else {
            // Update clinic to use target ComplexDepartment
            await this.clinicModel.updateOne(
              { _id: clinic._id },
              { complexDepartmentId: targetComplexDept._id },
            );

            this.logger.log(
              `Transferred clinic ${clinic._id} from department ${departmentId} to ${targetDepartmentId}`,
            );
          }

          clinicsTransferred++;
        }
      }

      // Step 6: Update source department status to 'inactive'
      await this.departmentModel.findByIdAndUpdate(departmentId, {
        status: 'inactive',
      });

      this.logger.log(
        `Department ${departmentId} deactivated with ${clinicsTransferred} clinics transferred to ${targetDepartmentId}`,
      );

      // Step 7: Return success response
      return {
        success: true,
        message: DEPARTMENT_SUCCESS_MESSAGES.DEACTIVATED_WITH_TRANSFER,
        clinicsTransferred,
      };
    } catch (error) {
      // Re-throw known exceptions
      if (
        error instanceof NotFoundException ||
        error instanceof BadRequestException
      ) {
        throw error;
      }

      // Handle unexpected errors
      this.logger.error(
        `Unexpected error deactivating department ${departmentId} with transfer to ${targetDepartmentId}:`,
        error.stack,
      );

      throw new BadRequestException({
        message: {
          ar: 'حدث خطأ أثناء إلغاء تفعيل القسم ونقل العيادات',
          en: 'An error occurred while deactivating department and transferring clinics',
        },
      });
    }
  }

  /**
   * Update department status
   *
   * Updates the status of a department to active or inactive.
   * When deactivating a department that has linked clinics, it will fail
   * and require using the deactivateWithTransfer method instead.
   *
   * @param departmentId - Department ID to update
   * @param status - New status ('active' or 'inactive')
   * @returns Updated department document
   *
   * @throws NotFoundException if department not found
   * @throws BadRequestException if trying to deactivate department with linked clinics
   *
   * @example
   * const dept = await service.updateDepartmentStatus('dept-id', 'inactive');
   */
  async updateDepartmentStatus(
    departmentId: string,
    status: 'active' | 'inactive',
  ): Promise<Department> {
    try {
      // Validate department exists
      await this.validateDepartmentExists(departmentId);

      // If deactivating, check for linked clinics
      if (status === 'inactive') {
        const complexDeptIds = await this.getComplexDepartmentIds(departmentId);
    const linkedClinics = await this.getLinkedClinics(
      departmentId,
      complexDeptIds,
    );

        if (linkedClinics.length > 0) {
          const formattedClinics = this.formatLinkedClinics(linkedClinics);

          throw new BadRequestException({
            message: {
              ar: 'لا يمكن إلغاء تفعيل القسم لأنه مرتبط بعيادات. استخدم endpoint إلغاء التفعيل مع النقل بدلاً من ذلك',
              en: 'Cannot deactivate department because it has linked clinics. Use deactivate-with-transfer endpoint instead',
            },
            code: DEPARTMENT_ERROR_CODES.LINKED_TO_CLINICS,
            linkedClinics: formattedClinics,
            linkedClinicsCount: linkedClinics.length,
          });
        }
      }

      // Update status
      const updatedDepartment = await this.departmentModel
        .findByIdAndUpdate(
          departmentId,
          { status },
          { new: true, runValidators: true },
        )
        .exec();

      if (!updatedDepartment) {
        throw new NotFoundException({
          message: DEPARTMENT_ERROR_MESSAGES.NOT_FOUND,
          code: DEPARTMENT_ERROR_CODES.NOT_FOUND,
        });
      }

      this.logger.log(`Department ${departmentId} status updated to ${status}`);

      return updatedDepartment;
    } catch (error) {
      // Re-throw known exceptions
      if (
        error instanceof NotFoundException ||
        error instanceof BadRequestException
      ) {
        throw error;
      }

      // Handle unexpected errors
      this.logger.error(
        `Unexpected error updating department ${departmentId} status:`,
        error.stack,
      );

      throw new BadRequestException({
        message: {
          ar: 'حدث خطأ أثناء تحديث حالة القسم',
          en: 'An error occurred while updating department status',
        },
      });
    }
  }
}
