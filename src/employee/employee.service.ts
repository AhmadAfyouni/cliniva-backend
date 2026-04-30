import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types, RootFilterQuery } from 'mongoose';
import * as bcrypt from 'bcrypt';
import { User } from '../database/schemas/user.schema';
import { EmployeeProfile } from '../database/schemas/employee-profile.schema';
import { EmployeeDocument } from '../database/schemas/employee-document.schema';
import { EmployeeShift } from '../database/schemas/employee-shift.schema';
import { Organization } from '../database/schemas/organization.schema';
import { Complex } from '../database/schemas/complex.schema';
import { Clinic } from '../database/schemas/clinic.schema';
import { UserAccess } from '../database/schemas/user-access.schema';
import { DoctorSpecialty } from '../database/schemas/doctor-specialty.schema';
import { Specialty } from '../database/schemas/specialty.schema';
import {
  CreateEmployeeDto,
  UpdateEmployeeDto,
  EmployeeSearchQueryDto,
  CreateEmployeeDocumentDto,
  UpdateEmployeeDocumentDto,
  CreateEmployeeShiftDto,
  BulkEmployeeActionDto,
  EmployeeStatsDto,
  TerminateEmployeeDto,
} from './dto';
import { ValidationUtil } from '../common/utils/validation.util';
import { ResponseBuilder } from '../common/utils/response-builder.util';
import { ERROR_MESSAGES } from '../common/utils/error-messages.constant';
import { AuditService } from '../auth/audit.service';
import { SessionService } from '../auth/session.service';
import { EmailService } from '../auth/email.service';

@Injectable()
export class EmployeeService {
  private readonly logger = new Logger(EmployeeService.name);
  private readonly uniqueEmployeeFields = [
    'username',
    'email',
    'phone',
    'cardNumber',
  ] as const;

  private toObjectIdString(value: any): string | null {
    if (!value) {
      return null;
    }

    if (value instanceof Types.ObjectId) {
      return value.toString();
    }

    if (typeof value === 'object' && value._id) {
      return this.toObjectIdString(value._id);
    }

    return String(value);
  }

  private toLinkedEntity(
    entity: any,
    fallbackId?: any,
  ): { id: string | null; name: string | null } | null {
    const id = this.toObjectIdString(entity?._id ?? fallbackId);
    const name = entity?.name ?? null;

    if (!id && !name) {
      return null;
    }

    return {
      id,
      name,
    };
  }

  private enrichEmployeeResponse(employee: any): any {
    if (!employee) {
      return employee;
    }

    const { clinic, complex, clinicsList, ...employeeWithoutLinkedEntities } = employee;

    return {
      ...employeeWithoutLinkedEntities,
      userType: employee.role,
      linkedComplex: this.toLinkedEntity(employee.complex, employee.complexId),
      linkedClinics: (employee.clinicsList || [])
        .map((c: any) => this.toLinkedEntity(c, null))
        .filter((c: any) => c !== null),
    };
  }

  constructor(
    @InjectModel('User') private readonly userModel: Model<User>,
    @InjectModel('EmployeeProfile')
    private readonly employeeProfileModel: Model<EmployeeProfile>,
    @InjectModel('EmployeeDocument')
    private readonly employeeDocumentModel: Model<EmployeeDocument>,
    @InjectModel('EmployeeShift')
    private readonly employeeShiftModel: Model<EmployeeShift>,
    @InjectModel('Organization')
    private readonly organizationModel: Model<Organization>,
    @InjectModel('Complex') private readonly complexModel: Model<Complex>,
    @InjectModel('Clinic') private readonly clinicModel: Model<Clinic>,
    @InjectModel('UserAccess')
    private readonly userAccessModel: Model<UserAccess>,
    @InjectModel('DoctorSpecialty')
    private readonly doctorSpecialtyModel: Model<DoctorSpecialty>,
    @InjectModel('Specialty')
    private readonly specialtyModel: Model<Specialty>,
    private readonly auditService: AuditService,
    private readonly sessionService: SessionService,
    private readonly emailService: EmailService,
  ) {}

  async isEmployeeFieldValueAvailable(
    field: 'username' | 'email' | 'phone' | 'cardNumber',
    value: string,
  ): Promise<boolean> {
    const normalizedValue = (value || '').trim();

    if (!normalizedValue) {
      throw new BadRequestException(`${field} is required`);
    }

    if (!this.uniqueEmployeeFields.includes(field)) {
      throw new BadRequestException('Invalid unique field');
    }

    if (field === 'username') {
      const existingUser = await this.userModel
        .findOne({ username: normalizedValue.toLowerCase(), isActive: true })
        .select('_id')
        .lean()
        .exec();
      return !existingUser;
    }

    if (field === 'email') {
      const existingUser = await this.userModel
        .findOne({ email: normalizedValue.toLowerCase(), isActive: true })
        .select('_id')
        .lean()
        .exec();
      return !existingUser;
    }

    if (field === 'phone') {
      const existingUser = await this.userModel
        .findOne({ phone: normalizedValue, isActive: true })
        .select('_id')
        .lean()
        .exec();
      return !existingUser;
    }

    const existingEmployee = await this.employeeProfileModel
      .findOne({ cardNumber: normalizedValue, isActive: true })
      .select('_id')
      .lean()
      .exec();
    return !existingEmployee;
  }

  /**
   * Generate unique employee number
   */
  private async generateEmployeeNumber(): Promise<string> {
    const currentYear = new Date().getFullYear();
    const prefix = `EMP${currentYear}`;

    // Find the last employee number for this year
    const lastEmployee = await this.employeeProfileModel
      .findOne({
        employeeNumber: { $regex: `^${prefix}` },
      })
      .sort({ employeeNumber: -1 })
      .exec();

    let nextNumber = 1;
    if (lastEmployee && lastEmployee.employeeNumber) {
      const lastNumber = parseInt(
        lastEmployee.employeeNumber.substring(prefix.length),
      );
      nextNumber = lastNumber + 1;
    }

    return `${prefix}${nextNumber.toString().padStart(4, '0')}`;
  }

  /**
   * Validate employee data
   */
  private async validateEmployeeData(
    employeeDto: CreateEmployeeDto | UpdateEmployeeDto,
    isUpdate = false,
    employeeId?: string,
  ): Promise<void> {
    const createDto = employeeDto as CreateEmployeeDto;

    // For creation, validate required fields and uniqueness
    if (!isUpdate) {
      // Check username uniqueness
      const existingUserByUsername = await this.userModel.findOne({
        username: createDto.username.toLowerCase().trim(),
        isActive: true,
      });

      if (existingUserByUsername) {
        throw new ConflictException('Username already exists');
      }

      // Check email uniqueness
      const existingUserByEmail = await this.userModel.findOne({
        email: createDto.email,
        isActive: true,
      });

      if (existingUserByEmail) {
        throw new ConflictException('Email already exists');
      }

      // Validate phone uniqueness (only if phone is provided)
      if (createDto.phone) {
        const existingUserByPhone = await this.userModel.findOne({
          phone: createDto.phone,
          isActive: true,
        });

        if (existingUserByPhone) {
          throw new ConflictException('Phone number already exists');
        }
      }

      // Validate employee number uniqueness (if provided)
      if (createDto.employeeNumber) {
        const existingEmployee = await this.employeeProfileModel.findOne({
          employeeNumber: createDto.employeeNumber,
          isActive: true,
        });

        if (existingEmployee) {
          throw new ConflictException('Employee number already exists');
        }
      }

      // Validate card number uniqueness (if provided)
      if (createDto.cardNumber) {
        const existingEmployeeByCard = await this.employeeProfileModel.findOne({
          cardNumber: createDto.cardNumber,
          isActive: true,
        });

        if (existingEmployeeByCard) {
          throw new ConflictException('Card number already exists');
        }
      }
    }

    // Validate date of birth (should not be in the future and person should be at least 16)
    if (createDto.dateOfBirth) {
      const birthDate = new Date(createDto.dateOfBirth);
      const today = new Date();
      const minAge = new Date(
        today.getFullYear() - 16,
        today.getMonth(),
        today.getDate(),
      );

      if (birthDate > today) {
        throw new BadRequestException('Date of birth cannot be in the future');
      }

      if (birthDate > minAge) {
        throw new BadRequestException('Employee must be at least 16 years old');
      }
    }

    // Validate date of hiring
    if (createDto.dateOfHiring) {
      const hiringDate = new Date(createDto.dateOfHiring);
      const today = new Date();
      const maxFutureDate = new Date(
        today.getFullYear() + 1,
        today.getMonth(),
        today.getDate(),
      );

      if (hiringDate > maxFutureDate) {
        throw new BadRequestException(
          'Hiring date cannot be more than 1 year in the future',
        );
      }
    }

    // Validate salary (if provided, should be reasonable)
    if (
      createDto.salary &&
      (createDto.salary < 0 || createDto.salary > 1000000)
    ) {
      throw new BadRequestException('Salary must be between 0 and 1,000,000');
    }

    // Validate assignment entities exist
    if (createDto.organizationId) {
      const organization = await this.organizationModel.findById(
        createDto.organizationId,
      );
      if (!organization) {
        throw new NotFoundException('Organization not found');
      }
    }

    if (createDto.complexId) {
      const complex = await this.complexModel.findById(createDto.complexId);
      if (!complex) {
        throw new NotFoundException('Complex not found');
      }
    }

    if (createDto.clinicId) {
      const clinic = await this.clinicModel.findById(createDto.clinicId);
      if (!clinic) {
        throw new NotFoundException('Clinic not found');
      }
    }
  }

  /**
   * Validate single complex assignment
   * Ensures that all clinics assigned to an employee belong to the same complex.
   *
   * Business Rule: BZR-5e6f7a8b - Single complex assignment validation
   * Requirements: 3.5
   * Design: Section 3.3.1
   *
   * @private
   * @param {Object} employeeDto - Employee data containing complexId and clinicIds
   * @param {string} [employeeDto.complexId] - The complex ID the employee is assigned to
   * @param {string[]} [employeeDto.clinicIds] - Array of clinic IDs the employee is assigned to
   * @returns {Promise<void>}
   * @throws {BadRequestException} When clinics belong to different complexes
   *
   * @example
   * // Valid: All clinics belong to the same complex
   * await this.validateSingleComplexAssignment({
   *   complexId: 'complex123',
   *   clinicIds: ['clinic1', 'clinic2']
   * });
   *
   * @example
   * // Invalid: Clinics belong to different complexes
   * await this.validateSingleComplexAssignment({
   *   complexId: 'complex123',
   *   clinicIds: ['clinic1', 'clinic2'] // clinic2 belongs to complex456
   * });
   * // Throws BadRequestException with bilingual error message
   */
  private async validateSingleComplexAssignment(employeeDto: {
    complexId?: string;
    clinicIds?: string[];
  }): Promise<void> {
    // Skip validation if no complex or clinics provided
    if (!employeeDto.complexId || !employeeDto.clinicIds?.length) {
      return;
    }

    // Use ValidationUtil to validate single complex assignment
    await ValidationUtil.validateSingleComplexAssignment(
      employeeDto.clinicIds,
      employeeDto.complexId,
      this.clinicModel,
    );
  }

  /**
   * Validate plan-based assignment
   * Ensures that employee assignments match the subscription plan type.
   *
   * Business Rules:
   * - BZR-i4c3e2f7: Plan 2 (Complex) - Complex must match subscription
   * - BZR-j8a9f0d5: Plan 3 (Clinic) - Clinic must match subscription
   *
   * Requirements: 3.6
   * Design: Section 3.3.1
   *
   * @private
   * @param {Object} employeeDto - Employee data containing assignment IDs
   * @param {string} [employeeDto.complexId] - The complex ID the employee is assigned to
   * @param {string} [employeeDto.clinicId] - The clinic ID the employee is assigned to
   * @param {Object} subscription - User's subscription information
   * @param {string} subscription.planType - Plan type: 'company', 'complex', or 'clinic'
   * @param {Types.ObjectId} [subscription.complexId] - Complex ID from subscription (for Plan 2)
   * @param {Types.ObjectId} [subscription.clinicId] - Clinic ID from subscription (for Plan 3)
   * @returns {Promise<void>}
   * @throws {BadRequestException} When assignment doesn't match subscription plan
   *
   * @example
   * // Valid: Plan 2 (Complex) - Complex matches subscription
   * await this.validatePlanBasedAssignment(
   *   { complexId: 'complex123' },
   *   { planType: 'complex', complexId: new Types.ObjectId('complex123') }
   * );
   *
   * @example
   * // Invalid: Plan 2 (Complex) - Complex doesn't match subscription
   * await this.validatePlanBasedAssignment(
   *   { complexId: 'complex456' },
   *   { planType: 'complex', complexId: new Types.ObjectId('complex123') }
   * );
   * // Throws BadRequestException with bilingual error message
   *
   * @example
   * // Valid: Plan 3 (Clinic) - Clinic matches subscription
   * await this.validatePlanBasedAssignment(
   *   { clinicId: 'clinic789' },
   *   { planType: 'clinic', clinicId: new Types.ObjectId('clinic789') }
   * );
   */
  private async validatePlanBasedAssignment(
    employeeDto: any,
    subscription: any,
  ): Promise<void> {
    // Plan 2: Complex plan - validate complex matches subscription
    if (subscription.planType === 'complex') {
      if (
        employeeDto.complexId &&
        employeeDto.complexId !== subscription.complexId?.toString()
      ) {
        throw new BadRequestException({
          message: {
            ar: 'يجب أن يتطابق المجمع مع اشتراكك',
            en: 'Complex must match your subscription',
          },
          code: 'COMPLEX_MISMATCH',
          details: {
            subscriptionComplexId: subscription.complexId,
            providedComplexId: employeeDto.complexId,
          },
        });
      }
    }
    // Plan 3: Clinic plan - validate clinic matches subscription
    else if (subscription.planType === 'clinic') {
      if (
        employeeDto.clinicId &&
        employeeDto.clinicId !== subscription.clinicId?.toString()
      ) {
        throw new BadRequestException({
          message: {
            ar: 'يجب أن تتطابق العيادة مع اشتراكك',
            en: 'Clinic must match your subscription',
          },
          code: 'CLINIC_MISMATCH',
          details: {
            subscriptionClinicId: subscription.clinicId,
            providedClinicId: employeeDto.clinicId,
          },
        });
      }
    }
    // Plan 1: Company plan - no specific validation needed
    // Employees can be assigned to any organization/complex/clinic within the company
  }

  /**
   * Create a new employee
   *
   * Business Rules:
   * - BZR-5e6f7a8b: Single complex assignment validation
   * - BZR-i4c3e2f7: Plan 2 - Complex must match subscription
   * - BZR-j8a9f0d5: Plan 3 - Clinic must match subscription
   *
   * Requirements: 3.5, 3.6
   * Design: Section 3.3.1
   */
  async createEmployee(
    createEmployeeDto: CreateEmployeeDto,
    createdByUserId?: string,
    subscription?: any,
    requestingUser?: any,
  ): Promise<any> {
    this.logger.log(`Creating employee: ${createEmployeeDto.username}`);

    // Validate employee data (existing validation)
    await this.validateEmployeeData(createEmployeeDto);

    // Validate single complex assignment
    // BZR-5e6f7a8b: Ensures all clinics belong to the same complex
    // Note: Current DTO has clinicId (singular), validation expects clinicIds (array)
    // This will be fully utilized when DTO is updated to support multiple clinic assignments
    await this.validateSingleComplexAssignment(createEmployeeDto as any);

    // Validate plan-based assignment if subscription is provided
    // BZR-i4c3e2f7, BZR-j8a9f0d5: Ensures assignments match subscription plan
    if (subscription) {
      await this.validatePlanBasedAssignment(createEmployeeDto, subscription);
    }

    // Auto-assign clinicId when not explicitly provided and requestingUser is scoped to a clinic.
    // Prevents employees from being created without clinic linkage when the frontend
    // auth context doesn't yet have clinicId (e.g., right after account creation).
    if (!createEmployeeDto.clinicId && requestingUser?.clinicId) {
      createEmployeeDto.clinicId = requestingUser.clinicId.toString();
    }

    const normalizedRole = createEmployeeDto.role || createEmployeeDto.userType;

    const specialties = Array.isArray(createEmployeeDto.specialties)
      ? createEmployeeDto.specialties.filter(Boolean)
      : [];

    if (specialties.length > 0 && normalizedRole !== 'doctor') {
      throw new BadRequestException(
        'Specialties can only be assigned to users with doctor role',
      );
    }

    const uniqueSpecialtyIds = Array.from(new Set(specialties));
    const specialtyObjectIds = uniqueSpecialtyIds.map((specialtyId) => {
      if (!Types.ObjectId.isValid(specialtyId)) {
        throw new BadRequestException(`Invalid specialty ID format: ${specialtyId}`);
      }

      return new Types.ObjectId(specialtyId);
    });

    if (specialtyObjectIds.length > 0) {
      const existingSpecialties = await this.specialtyModel
        .find(
          {
            _id: { $in: specialtyObjectIds },
            isActive: true,
          },
          { _id: 1 },
        )
        .lean()
        .exec();

      const existingIdSet = new Set(existingSpecialties.map((item: any) => item._id.toString()));
      const missingSpecialtyIds = uniqueSpecialtyIds.filter(
        (specialtyId) => !existingIdSet.has(specialtyId),
      );

      if (missingSpecialtyIds.length > 0) {
        throw new BadRequestException(
          `Invalid or inactive specialty IDs: ${missingSpecialtyIds.join(', ')}`,
        );
      }
    }

    // Hash the password
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(
      createEmployeeDto.password,
      saltRounds,
    );

    // Generate employee number if not provided
    const employeeNumber =
      createEmployeeDto.employeeNumber || (await this.generateEmployeeNumber());

    const explicitSubscriptionId = (createEmployeeDto as any).subscriptionId;

    let resolvedSubscriptionId: Types.ObjectId | undefined;

    if (
      requestingUser?.role === 'super_admin' &&
      explicitSubscriptionId &&
      Types.ObjectId.isValid(explicitSubscriptionId)
    ) {
      resolvedSubscriptionId = new Types.ObjectId(explicitSubscriptionId);
    } else if (requestingUser?.subscriptionId && Types.ObjectId.isValid(requestingUser.subscriptionId)) {
      resolvedSubscriptionId = new Types.ObjectId(requestingUser.subscriptionId);
    } else if (createEmployeeDto.clinicId) {
      const clinic = await this.clinicModel
        .findById(createEmployeeDto.clinicId)
        .select('_id subscriptionId')
        .lean()
        .exec();
      if (clinic?.subscriptionId && Types.ObjectId.isValid(clinic.subscriptionId as any)) {
        resolvedSubscriptionId = new Types.ObjectId(clinic.subscriptionId as any);
      }
    } else if (createEmployeeDto.complexId) {
      const complex = await this.complexModel
        .findById(createEmployeeDto.complexId)
        .select('_id subscriptionId')
        .lean()
        .exec();
      if (complex?.subscriptionId && Types.ObjectId.isValid(complex.subscriptionId as any)) {
        resolvedSubscriptionId = new Types.ObjectId(complex.subscriptionId as any);
      }
    } else if (createEmployeeDto.organizationId) {
      const organization = await this.organizationModel
        .findById(createEmployeeDto.organizationId)
        .select('_id subscriptionId')
        .lean()
        .exec();
      if (
        organization?.subscriptionId &&
        Types.ObjectId.isValid(organization.subscriptionId as any)
      ) {
        resolvedSubscriptionId = new Types.ObjectId(organization.subscriptionId as any);
      }
    }

    // Create user account
    const userData = {
      username: createEmployeeDto.username.toLowerCase().trim(),
      email: createEmployeeDto.email,
      passwordHash: hashedPassword,
      firstName: createEmployeeDto.firstName,
      lastName: createEmployeeDto.lastName,
      phone: createEmployeeDto.phone,
      role: normalizedRole,
      nationality: createEmployeeDto.nationality,
      gender: createEmployeeDto.gender,
      dateOfBirth: new Date(createEmployeeDto.dateOfBirth),
      address: createEmployeeDto.address,
      subscriptionId: resolvedSubscriptionId,
      organizationId: createEmployeeDto.organizationId,
      complexId: createEmployeeDto.complexId && Types.ObjectId.isValid(createEmployeeDto.complexId)
        ? new Types.ObjectId(createEmployeeDto.complexId) : createEmployeeDto.complexId,
      clinicId: createEmployeeDto.clinicId && Types.ObjectId.isValid(createEmployeeDto.clinicId)
        ? new Types.ObjectId(createEmployeeDto.clinicId) : createEmployeeDto.clinicId,
      clinicIds: (
        createEmployeeDto.clinicIds?.length
          ? createEmployeeDto.clinicIds
          : createEmployeeDto.clinicId ? [createEmployeeDto.clinicId] : []
      ).filter((id: string) => Types.ObjectId.isValid(id)).map((id: string) => new Types.ObjectId(id)),
      isActive: true,
      emailVerified: false, // Will need to verify email
      setupComplete: false,
      onboardingComplete: false,
    };

    const user = new this.userModel(userData);
    const savedUser = await user.save();

    // Create employee profile
    const profileData = {
      userId: savedUser._id,
      employeeNumber,
      cardNumber: createEmployeeDto.cardNumber,
      maritalStatus: createEmployeeDto.maritalStatus,
      numberOfChildren: createEmployeeDto.numberOfChildren || 0,
      profilePictureUrl: createEmployeeDto.profilePictureUrl,
      jobTitle: createEmployeeDto.jobTitle,
      dateOfHiring: new Date(createEmployeeDto.dateOfHiring),
      salary: createEmployeeDto.salary,
      bankAccount: createEmployeeDto.bankAccount,
      socialSecurityNumber: createEmployeeDto.socialSecurityNumber,
      taxId: createEmployeeDto.taxId,
      notes: createEmployeeDto.notes,
      isActive: true,
    };

    const employeeProfile = new this.employeeProfileModel(profileData);
    await employeeProfile.save();

    if (specialtyObjectIds.length > 0) {
      const doctorSpecialtyAssignments = specialtyObjectIds.map((specialtyId) => ({
        doctorId: savedUser._id,
        specialtyId,
        isActive: true,
      }));

      await this.doctorSpecialtyModel.insertMany(doctorSpecialtyAssignments, {
        ordered: true,
      });
    }

    // Audit log for employee creation
    if (createdByUserId) {
      await this.auditService.logEmployeeCreated(
        (savedUser._id as Types.ObjectId).toString(),
        createdByUserId,
        '0.0.0.0', // IP address should be passed from controller
        undefined, // User agent should be passed from controller
        {
          email: savedUser.email,
          role: savedUser.role,
          employeeNumber,
          jobTitle: createEmployeeDto.jobTitle,
        },
      );
    }

    this.logger.log(
      `Employee created successfully: ${savedUser.email} (ID: ${savedUser._id})`,
    );

    // Return complete employee details with linked entity names and ids
    return await this.getEmployeeById((savedUser._id as Types.ObjectId).toString());
  }

  /**
   * Get employees with filtering and pagination
   */
  async getEmployees(query: EmployeeSearchQueryDto, requestingUser?: any): Promise<{
    employees: any[];
    total: number;
    page: number;
    totalPages: number;
  }> {
    const {
      search,
      firstName,
      lastName,
      email,
      employeeNumber,
      jobTitle,
      organizationId,
      complexId,
      clinicId,
      clinicIds,
      dateHiredFrom,
      dateHiredTo,
      page = '1',
      limit = '10',
      sortBy = 'createdAt',
      sortOrder: originalSortOrder,
      order,
      filter_fields,
    } = query;

    let { role, isActive } = query;
    let sortOrder = originalSortOrder || 'desc';

    // Handle 'order' as alias for 'sortOrder'
    if (order && !originalSortOrder) {
      sortOrder = order;
    }

    // Handle filter_fields JSON string (used by frontend generic list)
    if (filter_fields) {
      try {
        const parsedFilters = JSON.parse(filter_fields);
        
        // Map employeeType to role
        if (parsedFilters.employeeType === 'Doctor' && !role) {
          role = 'doctor';
        } else if ((parsedFilters.employeeType === 'Staff' || parsedFilters.employeeType === 'Staff Member') && !role) {
          role = 'staff';
        }

        // Map roleName to role
        if (parsedFilters.roleName && !role) {
          const roleMap: Record<string, string> = {
            'Doctor': 'doctor',
            'Staff': 'staff',
            'Admin': 'admin',
            'Owner': 'owner',
            'Super Admin': 'super_admin',
            'Patient': 'patient'
          };
          role = roleMap[parsedFilters.roleName] || parsedFilters.roleName.toLowerCase();
        }

        // Map isActive
        if (parsedFilters.isActive !== undefined && isActive === undefined) {
          isActive = parsedFilters.isActive === 'true' || parsedFilters.isActive === true;
        }
      } catch (e) {
        this.logger.warn(`Failed to parse filter_fields: ${filter_fields}`);
      }
    }

    // Doctors and staff may only list doctors (not admins/staff data)
    if (requestingUser && (requestingUser.role === 'doctor' || requestingUser.role === 'staff')) {
      role = 'doctor';
    }

    // TENANT ISOLATION: enforce scope based on requesting user
    let effectiveClinicId: string | string[] | undefined = clinicId;
    let effectiveComplexId = complexId;
    let effectiveOrgId = organizationId;

    if (requestingUser && !['super_admin', 'admin'].includes(requestingUser.role)) {
      // 1. Mandatory subscription-level tenant isolation
      if (requestingUser.subscriptionId) {
        effectiveOrgId = requestingUser.subscriptionId.toString();
      }

      // 2. Resolve role-based scope restrictions
      if (requestingUser.role === 'owner') {
        // Owners have subscription-level access — no further restrictions unless explicitly queried
      } else {
        // Higher-order scope resolution: Complex > Clinic
        if (requestingUser.complexId) {
          // If user has complex access, that is their primary scope
          if (!effectiveComplexId) effectiveComplexId = requestingUser.complexId.toString();
          // They can see all clinics within this complex unless they explicitly narrowed to one
        } else if (requestingUser.clinicId) {
          // Fallback to clinic scope for users restricted to a single clinic
          if (!effectiveClinicId) effectiveClinicId = requestingUser.clinicId.toString();
        }
      }

      const userId = requestingUser.role !== 'owner'
        ? (requestingUser.userId || requestingUser.id)
        : null;
      if (userId) {
        const now = new Date();
        const accessRecords = await this.userAccessModel
          .find({
            userId: new Types.ObjectId(userId),
            isActive: true,
            $or: [
              { expiresAt: { $gt: now } },
              { expiresAt: { $exists: false } },
              { expiresAt: null },
            ],
          })
          .lean()
          .exec();

        if (accessRecords.length > 0) {
          const directClinicIds = accessRecords
            .filter((a) => a.scopeType === 'clinic')
            .map((a) => new Types.ObjectId(a.scopeId));

          const accessComplexIds = accessRecords
            .filter((a) => a.scopeType === 'complex')
            .map((a) => new Types.ObjectId(a.scopeId));

          let complexClinicIds: Types.ObjectId[] = [];
          if (accessComplexIds.length > 0) {
            const complexClinics = await this.clinicModel
              .find({ complexId: { $in: accessComplexIds } }, { _id: 1 })
              .lean()
              .exec();
            complexClinicIds = complexClinics.map(
              (c) => new Types.ObjectId((c._id as any).toString()),
            );
          }

          const expandedClinicIds = [...directClinicIds, ...complexClinicIds];
          if (expandedClinicIds.length > 0) {
            effectiveClinicId = expandedClinicIds.map((id) => id.toString());
            effectiveComplexId = undefined;
            // Note: we still keep effectiveOrgId for tenant isolation
          }
        }
      }
    }

    // Build user filter
    const userFilter: any = {};

    // 1. Mandatory Tenant Isolation — ALWAYS applied for non-super_admins
    if (effectiveOrgId) {
      userFilter.subscriptionId = new Types.ObjectId(effectiveOrgId);
    }

    // ROLE-BASED RESTRICTION: Doctors can ONLY see themselves
    if (requestingUser && requestingUser.role === 'doctor') {
      userFilter._id = new Types.ObjectId(requestingUser.userId || requestingUser.id);
    } else if (requestingUser && requestingUser.role === 'staff') {
      role = 'doctor';
      userFilter.role = 'doctor';
      // Staff are scoped strictly to their assigned clinic(s) — override any broader
      // scope that the UserAccess lookup may have resolved (e.g. complex-level access
      // expanding to all clinics within the complex).
      if (Array.isArray(requestingUser.clinicIds) && requestingUser.clinicIds.length > 0) {
        effectiveClinicId = requestingUser.clinicIds;
        effectiveComplexId = undefined;
      } else if (requestingUser.clinicId) {
        effectiveClinicId = requestingUser.clinicId.toString();
        effectiveComplexId = undefined;
      }
    }

    if (firstName) userFilter.firstName = { $regex: firstName, $options: 'i' };
    if (lastName) userFilter.lastName = { $regex: lastName, $options: 'i' };
    if (email) userFilter.email = { $regex: email, $options: 'i' };
    if (role) userFilter.role = role;
    if (isActive !== undefined) userFilter.isActive = isActive;

    if (effectiveClinicId) {
      if (Array.isArray(effectiveClinicId)) {
        userFilter.clinicId = {
          $in: effectiveClinicId.map((id) => new Types.ObjectId(id)),
        };
      } else {
        userFilter.clinicId = new Types.ObjectId(effectiveClinicId);
      }
    }
    // Multi-clinic filter: when clinicIds (comma-separated) is provided and no single clinicId forced by role
    if (!effectiveClinicId && clinicIds) {
      const ids = clinicIds.split(',').map((id) => id.trim()).filter(Boolean);
      if (ids.length > 0) {
        userFilter.clinicIds = { $in: ids.map((id) => new Types.ObjectId(id)) };
      }
    }
    if (!effectiveClinicId && !clinicIds && effectiveComplexId) {
      userFilter.complexId = new Types.ObjectId(effectiveComplexId);
    }

    // Search across multiple fields (name, email, phone, employee ID, or partial _id)
    if (search) {
      // Strip common display-ID prefixes so "US-A1B2" → "A1B2" matches the raw ObjectId string
      const idTerm = search.replace(/^(US|EMP)-?/i, '').trim();

      userFilter.$or = [
        { firstName: { $regex: search, $options: 'i' } },
        { lastName: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
        { phone: { $regex: search, $options: 'i' } },
        { 'employeeProfile.employeeNumber': { $regex: search, $options: 'i' } },
        // Partial match on the ObjectId string (powers "US-XXXX" and raw suffix searches)
        ...(idTerm.length > 0
          ? [{ $expr: { $regexMatch: { input: { $toString: '$_id' }, regex: idTerm, options: 'i' } } }]
          : []),
      ];
    }

    // Build employee profile filter
    const profileFilter: any = { isActive: true };

    if (employeeNumber)
      profileFilter.employeeNumber = { $regex: employeeNumber, $options: 'i' };
    if (jobTitle) profileFilter.jobTitle = { $regex: jobTitle, $options: 'i' };

    // Date filtering
    if (dateHiredFrom || dateHiredTo) {
      profileFilter.dateOfHiring = {};
      if (dateHiredFrom)
        profileFilter.dateOfHiring.$gte = new Date(dateHiredFrom);
      if (dateHiredTo) profileFilter.dateOfHiring.$lte = new Date(dateHiredTo);
    }

    // Pagination
    const pageNum = Math.max(1, parseInt(page));
    const pageSize = Math.max(1, Math.min(100, parseInt(limit)));
    const skip = (pageNum - 1) * pageSize;

    // Sorting
    const sort: any = {};
    if (sortBy.includes('.')) {
      // Handle nested sorting like 'employeeProfile.dateOfHiring'
      sort[sortBy] = sortOrder === 'asc' ? 1 : -1;
    } else {
      sort[sortBy] = sortOrder === 'asc' ? 1 : -1;
    }

    // Aggregate pipeline to join users with employee profiles
    const pipeline: any[] = [
      {
        $lookup: {
          from: 'employee_profiles',
          localField: '_id',
          foreignField: 'userId',
          as: 'employeeProfile',
        },
      },
      {
        $unwind: {
          path: '$employeeProfile',
          preserveNullAndEmptyArrays: true,
        },
      },
      {
        $match: (() => {
          // Build match stage carefully to avoid $or key collision.
          // userFilter may already contain $or (from search), and the profile check
          // also needs $or. Overwriting one with the other silently drops a condition.
          // Solution: when both exist, combine them under $and.
          const profileOr = [
            { 'employeeProfile.isActive': true },
            { 'employeeProfile._id': { $exists: false } },
          ];

          const { $or: searchOr, ...restUserFilter } = userFilter;

          const andConditions: any[] = [];
          if (searchOr) andConditions.push({ $or: searchOr });
          andConditions.push({ $or: profileOr });

          if (Object.keys(profileFilter).length > 1) {
            Object.entries(profileFilter).forEach(([key, value]) => {
              andConditions.push({ [`employeeProfile.${key}`]: value });
            });
          }

          return {
            ...restUserFilter,
            $and: andConditions,
          };
        })(),
      },
      {
        $lookup: {
          from: 'organizations',
          localField: 'organizationId',
          foreignField: '_id',
          as: 'organization',
        },
      },
      // Normalize complexId/clinicId — older records may store these as strings instead of ObjectId
      {
        $addFields: {
          clinicIdNorm: {
            $cond: {
              if: { $eq: [{ $type: '$clinicId' }, 'string'] },
              then: { $convert: { input: '$clinicId', to: 'objectId', onError: null, onNull: null } },
              else: '$clinicId',
            },
          },
          complexIdNorm: {
            $cond: {
              if: { $eq: [{ $type: '$complexId' }, 'string'] },
              then: { $convert: { input: '$complexId', to: 'objectId', onError: null, onNull: null } },
              else: '$complexId',
            },
          },
        },
      },
      {
        $lookup: {
          from: 'complexes',
          localField: 'complexIdNorm',
          foreignField: '_id',
          as: 'complex',
        },
      },
      {
        $lookup: {
          from: 'clinics',
          localField: 'clinicIdNorm',
          foreignField: '_id',
          as: 'clinic',
        },
      },
      {
        $lookup: {
          from: 'clinics',
          let: {
            clinicIds: {
              $map: {
                input: { $ifNull: ['$clinicIds', []] },
                as: 'cid',
                in: {
                  $cond: {
                    if: { $eq: [{ $type: '$$cid' }, 'string'] },
                    then: { $convert: { input: '$$cid', to: 'objectId', onError: null, onNull: null } },
                    else: '$$cid',
                  },
                },
              },
            },
          },
          pipeline: [{ $match: { $expr: { $in: ['$_id', '$$clinicIds'] } } }],
          as: 'clinicsList',
        },
      },
      {
        $addFields: {
          organization: { $arrayElemAt: ['$organization', 0] },
          complex: { $arrayElemAt: ['$complex', 0] },
          clinic: { $arrayElemAt: ['$clinic', 0] },
        },
      },
      {
        $sort: sort,
      },
      {
        $facet: {
          data: [{ $skip: skip }, { $limit: pageSize }],
          count: [{ $count: 'total' }],
        },
      },
    ];

    const result = await this.userModel.aggregate(pipeline).exec();

    const employees = result[0].data || [];
    const total = result[0].count[0]?.total || 0;
    const totalPages = Math.ceil(total / pageSize);

    return {
      employees: employees.map((employee: any) =>
        this.enrichEmployeeResponse(employee),
      ),
      total,
      page: pageNum,
      totalPages,
    };
  }

  /**
   * Get employee by ID
   */
  async getEmployeeById(employeeId: string, requestingUser?: any): Promise<any> {
    if (!Types.ObjectId.isValid(employeeId)) {
      throw new BadRequestException('Invalid employee ID format');
    }

    const pipeline: any[] = [
      {
        $match: { _id: new Types.ObjectId(employeeId) },
      },
      {
        $lookup: {
          from: 'employee_profiles',
          localField: '_id',
          foreignField: 'userId',
          as: 'employeeProfile',
        },
      },
      {
        $unwind: {
          path: '$employeeProfile',
          preserveNullAndEmptyArrays: true,
        },
      },
      {
        $lookup: {
          from: 'employee_shifts',
          localField: '_id',
          foreignField: 'userId',
          as: 'shifts',
        },
      },
      {
        $lookup: {
          from: 'working_hours',
          let: { userId: '$_id' },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ['$entityId', '$$userId'] },
                    { $eq: ['$entityType', 'user'] },
                    { $eq: ['$isActive', true] },
                  ],
                },
              },
            },
            {
              $sort: { dayOfWeek: 1 },
            },
          ],
          as: 'workingHours',
        },
      },
      {
        $lookup: {
          from: 'employee_documents',
          let: { userId: '$_id' },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ['$userId', '$$userId'] },
                    { $eq: ['$isActive', true] },
                    { $ne: ['$status', 'archived'] },
                  ],
                },
              },
            },
            {
              $sort: { createdAt: -1 },
            },
          ],
          as: 'documents',
        },
      },
      {
        $lookup: {
          from: 'organizations',
          localField: 'organizationId',
          foreignField: '_id',
          as: 'organization',
        },
      },
      {
        $lookup: {
          from: 'complexes',
          let: {
            complexId: {
              $convert: {
                input: '$complexId',
                to: 'objectId',
                onError: null,
                onNull: null,
              },
            },
          },
          pipeline: [
            {
              $match: {
                $expr: {
                  $eq: ['$_id', '$$complexId'],
                },
              },
            },
          ],
          as: 'complex',
        },
      },
      {
        $lookup: {
          from: 'clinics',
          let: {
            clinicId: {
              $convert: {
                input: '$clinicId',
                to: 'objectId',
                onError: null,
                onNull: null,
              },
            },
          },
          pipeline: [
            {
              $match: {
                $expr: {
                  $eq: ['$_id', '$$clinicId'],
                },
              },
            },
          ],
          as: 'clinic',
        },
      },
      {
        $lookup: {
          from: 'doctor_specialties',
          let: { doctorId: '$_id' },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ['$doctorId', '$$doctorId'] },
                    { $eq: ['$isActive', true] },
                  ],
                },
              },
            },
            {
              $lookup: {
                from: 'specialties',
                localField: 'specialtyId',
                foreignField: '_id',
                as: 'specialty',
              },
            },
            {
              $unwind: {
                path: '$specialty',
                preserveNullAndEmptyArrays: true,
              },
            },
            {
              $project: {
                _id: { $ifNull: ['$specialty._id', '$specialtyId'] },
                name: '$specialty.name',
                description: '$specialty.description',
                isActive: '$specialty.isActive',
                assignmentId: '$_id',
              },
            },
          ],
          as: 'specialties',
        },
      },
      {
        $lookup: {
          from: 'clinics',
          let: {
            clinicIds: {
              $map: {
                input: { $ifNull: ['$clinicIds', []] },
                as: 'cid',
                in: {
                  $cond: {
                    if: { $eq: [{ $type: '$$cid' }, 'string'] },
                    then: { $convert: { input: '$$cid', to: 'objectId', onError: null, onNull: null } },
                    else: '$$cid',
                  },
                },
              },
            },
          },
          pipeline: [{ $match: { $expr: { $in: ['$_id', '$$clinicIds'] } } }],
          as: 'clinicsList',
        },
      },
      {
        $addFields: {
          organization: { $arrayElemAt: ['$organization', 0] },
          complex: { $arrayElemAt: ['$complex', 0] },
          clinic: { $arrayElemAt: ['$clinic', 0] },
        },
      },
    ];

    const result = await this.userModel.aggregate(pipeline).exec();

    if (!result || result.length === 0) {
      throw new NotFoundException('Employee not found');
    }

    const employee = result[0];

    // IDOR protection: verify employee belongs to requesting user's tenant
    if (requestingUser && !['super_admin', 'admin'].includes(requestingUser.role)) {
      const empSubId = employee.subscriptionId?.toString();
      const userSubId = requestingUser.subscriptionId?.toString();
      if (empSubId && userSubId && empSubId !== userSubId) {
        throw new ForbiddenException({
          message: {
            ar: 'غير مصرح لك بالوصول إلى هذا الموظف',
            en: 'Access denied: employee belongs to a different tenant',
          },
          code: 'EMPLOYEE_403',
        });
      }
    }

    return this.enrichEmployeeResponse(employee);
  }

  /**
   * Update employee information
   *
   * Business Rules:
   * - BZR-5e6f7a8b: Single complex assignment validation
   * - BZR-i4c3e2f7: Plan 2 - Complex must match subscription
   * - BZR-j8a9f0d5: Plan 3 - Clinic must match subscription
   *
   * Requirements: 3.5, 3.6
   * Design: Section 3.3.1
   */
  async updateEmployee(
    employeeId: string,
    updateEmployeeDto: UpdateEmployeeDto,
    updatedByUserId?: string,
    subscription?: any,
  ): Promise<any> {
    this.logger.log(`Updating employee: ${employeeId}`);

    // Validate employee exists using ValidationUtil
    // This replaces the manual ObjectId validation and getEmployeeById check
    const employee = await ValidationUtil.validateEntityExists(
      this.userModel,
      employeeId,
      ERROR_MESSAGES.EMPLOYEE_NOT_FOUND,
    );

    // Validate employee data (existing validation for uniqueness, dates, etc.)
    await this.validateEmployeeData(updateEmployeeDto, true, employeeId);

    // Validate single complex assignment
    // BZR-5e6f7a8b: Ensures all clinics belong to the same complex
    // Note: Current DTO doesn't have complexId/clinicIds, but validation is ready for future use
    await this.validateSingleComplexAssignment(updateEmployeeDto as any);

    // Validate plan-based assignment if subscription is provided
    // BZR-i4c3e2f7, BZR-j8a9f0d5: Ensures assignments match subscription plan
    if (subscription) {
      await this.validatePlanBasedAssignment(updateEmployeeDto, subscription);
    }

    // Separate user updates from profile updates
    const userUpdates: any = {};
    const profileUpdates: any = {};

    // Track changes for session invalidation
    const emailChanged =
      updateEmployeeDto.email && updateEmployeeDto.email !== employee.email;
    const normalizedRole = updateEmployeeDto.userType || updateEmployeeDto.role;
    const roleChanged =
      normalizedRole && normalizedRole !== employee.role;
    const oldEmail = employee.email;
    const oldRole = employee.role;

    // User fields
    if (updateEmployeeDto.email) userUpdates.email = updateEmployeeDto.email;
    if (updateEmployeeDto.username) userUpdates.username = updateEmployeeDto.username.toLowerCase().trim();
    if (updateEmployeeDto.firstName)
      userUpdates.firstName = updateEmployeeDto.firstName;
    if (updateEmployeeDto.lastName)
      userUpdates.lastName = updateEmployeeDto.lastName;
    if (updateEmployeeDto.phone) userUpdates.phone = updateEmployeeDto.phone;
    if (updateEmployeeDto.nationality)
      userUpdates.nationality = updateEmployeeDto.nationality;
    if (updateEmployeeDto.address)
      userUpdates.address = updateEmployeeDto.address;
    if (updateEmployeeDto.gender) userUpdates.gender = updateEmployeeDto.gender;
    if (updateEmployeeDto.dateOfBirth) userUpdates.dateOfBirth = new Date(updateEmployeeDto.dateOfBirth);
    if (updateEmployeeDto.isActive !== undefined)
      userUpdates.isActive = updateEmployeeDto.isActive;
    if (normalizedRole) userUpdates.role = normalizedRole;
    if (updateEmployeeDto.clinicIds !== undefined) {
      userUpdates.clinicIds = updateEmployeeDto.clinicIds
        .filter((id) => Types.ObjectId.isValid(id))
        .map((id) => new Types.ObjectId(id));
      
      // Sync singular clinicId with the first element of clinicIds for legacy support
      if (userUpdates.clinicIds.length > 0) {
        userUpdates.clinicId = userUpdates.clinicIds[0];
      } else {
        userUpdates.clinicId = null;
      }
    }

    // Profile fields
    if (updateEmployeeDto.cardNumber)
      profileUpdates.cardNumber = updateEmployeeDto.cardNumber;
    if (updateEmployeeDto.maritalStatus)
      profileUpdates.maritalStatus = updateEmployeeDto.maritalStatus;
    if (updateEmployeeDto.numberOfChildren !== undefined)
      profileUpdates.numberOfChildren = updateEmployeeDto.numberOfChildren;
    if (updateEmployeeDto.profilePictureUrl)
      profileUpdates.profilePictureUrl = updateEmployeeDto.profilePictureUrl;
    if (updateEmployeeDto.jobTitle)
      profileUpdates.jobTitle = updateEmployeeDto.jobTitle;
    if (updateEmployeeDto.dateOfHiring)
      profileUpdates.dateOfHiring = new Date(updateEmployeeDto.dateOfHiring);
    if (updateEmployeeDto.salary !== undefined)
      profileUpdates.salary = updateEmployeeDto.salary;
    if (updateEmployeeDto.bankAccount)
      profileUpdates.bankAccount = updateEmployeeDto.bankAccount;
    if (updateEmployeeDto.socialSecurityNumber)
      profileUpdates.socialSecurityNumber =
        updateEmployeeDto.socialSecurityNumber;
    if (updateEmployeeDto.taxId) profileUpdates.taxId = updateEmployeeDto.taxId;
    if (updateEmployeeDto.notes) profileUpdates.notes = updateEmployeeDto.notes;

    // Update user if there are user updates
    if (Object.keys(userUpdates).length > 0) {
      await this.userModel.findByIdAndUpdate(
        employeeId,
        { $set: userUpdates },
        { new: true, runValidators: true },
      );

      // Handle session invalidation for email change
      if (emailChanged) {
        await this.sessionService.invalidateUserSessions(
          employeeId,
          'email_change',
          updatedByUserId,
        );

        const language = employee.preferredLanguage || 'en';
        await this.emailService.sendUsernameChangedNotification(
          updateEmployeeDto.email!,
          oldEmail,
          employee.firstName,
          language,
        );
      }

      // Handle session invalidation for role change
      if (roleChanged) {
        await this.sessionService.invalidateUserSessions(
          employeeId,
          'role_change',
          updatedByUserId,
        );

        const language = employee.preferredLanguage || 'en';
        await this.emailService.sendRoleChangedNotification(
          employee.email,
          employee.firstName,
          oldRole,
          normalizedRole!,
          language,
        );
      }
    }

    // Update employee profile if there are profile updates
    if (Object.keys(profileUpdates).length > 0) {
      await this.employeeProfileModel.findOneAndUpdate(
        { userId: new Types.ObjectId(employeeId) },
        { $set: profileUpdates },
        { new: true, runValidators: true },
      );
    }

    // Update doctor specialties if provided
    if (Array.isArray(updateEmployeeDto.specialties)) {
      const employeeObjectId = new Types.ObjectId(employeeId);
      // Delete all existing specialty assignments (unique index prevents re-inserting deactivated records)
      await this.doctorSpecialtyModel.deleteMany({ doctorId: employeeObjectId });
      // Create new active assignments
      if (updateEmployeeDto.specialties.length > 0) {
        const validIds = updateEmployeeDto.specialties
          .filter((id) => Types.ObjectId.isValid(id))
          .map((id) => new Types.ObjectId(id));
        if (validIds.length > 0) {
          const assignments = validIds.map((specialtyId) => ({
            doctorId: employeeObjectId,
            specialtyId,
            isActive: true,
            assignedAt: new Date(),
          }));
          await this.doctorSpecialtyModel.insertMany(assignments);
        }
      }
    }

    // Audit log for employee update
    if (updatedByUserId) {
      await this.auditService.logEmployeeUpdated(
        employeeId,
        updatedByUserId,
        '0.0.0.0', // IP address should be passed from controller
        undefined, // User agent should be passed from controller
        {
          userUpdates: Object.keys(userUpdates),
          profileUpdates: Object.keys(profileUpdates),
        },
      );
    }

    this.logger.log(`Employee updated successfully: ${employeeId}`);

    // Get updated employee data
    const updatedEmployee = await this.getEmployeeById(employeeId);

    // Return standardized response using ResponseBuilder
    return ResponseBuilder.success(
      updatedEmployee,
      ERROR_MESSAGES.EMPLOYEE_UPDATED,
    );
  }

  /**
   * Soft delete employee
   *
   * Business Rule: BZR-m3d5a8b7 - Cannot delete own account
   * Requirements: 3.1
   * Design: Section 3.3.1
   *
   * @param {string} employeeId - The ID of the employee to delete
   * @param {string} deletedByUserId - The ID of the user performing the deletion
   * @returns {Promise<any>} Standardized response with success message
   * @throws {BadRequestException} When trying to delete own account
   * @throws {NotFoundException} When employee is not found
   */
  async deleteEmployee(
    employeeId: string,
    deletedByUserId?: string,
  ): Promise<any> {
    this.logger.log(`Soft deleting employee: ${employeeId}`);

    // Validate employee exists using ValidationUtil
    const employee = await ValidationUtil.validateEntityExists(
      this.userModel,
      employeeId,
      ERROR_MESSAGES.EMPLOYEE_NOT_FOUND,
    );

    // Validate not self-deletion using ValidationUtil
    // BZR-m3d5a8b7: Prevents users from deleting their own account
    if (deletedByUserId) {
      ValidationUtil.validateNotSelfModification(
        employeeId,
        deletedByUserId,
        'delete',
      );
    }

    // Deactivate user account (soft delete)
    await this.userModel.findByIdAndUpdate(employeeId, {
      $set: {
        isActive: false,
      },
    });

    // Deactivate employee profile
    await this.employeeProfileModel.findOneAndUpdate(
      { userId: new Types.ObjectId(employeeId) },
      {
        $set: {
          isActive: false,
        },
      },
    );

    // Deactivate all shifts
    await this.employeeShiftModel.updateMany(
      { userId: new Types.ObjectId(employeeId) },
      {
        $set: {
          isActive: false,
        },
      },
    );

    // Audit log for employee deletion
    if (deletedByUserId) {
      await this.auditService.logEmployeeDeleted(
        employeeId,
        deletedByUserId,
        '0.0.0.0', // IP address should be passed from controller
        undefined, // User agent should be passed from controller
      );
    }

    this.logger.log(`Employee soft deleted successfully: ${employeeId}`);

    // Return standardized response using ResponseBuilder
    return ResponseBuilder.success(null, ERROR_MESSAGES.EMPLOYEE_DELETED);
  }

  /**
   * Terminate employee
   */
  async terminateEmployee(
    employeeId: string,
    terminateDto: TerminateEmployeeDto,
    terminatedByUserId?: string,
  ): Promise<any> {
    if (!Types.ObjectId.isValid(employeeId)) {
      throw new BadRequestException('Invalid employee ID format');
    }

    this.logger.log(`Terminating employee: ${employeeId}`);

    const employee = await this.getEmployeeById(employeeId);
    if (!employee) {
      throw new NotFoundException('Employee not found');
    }

    if (!employee.isActive) {
      throw new BadRequestException('Employee is already terminated');
    }

    const terminationDate = new Date(terminateDto.terminationDate);

    // Validate termination date
    if (terminationDate < employee.employeeProfile.dateOfHiring) {
      throw new BadRequestException(
        'Termination date cannot be before hiring date',
      );
    }

    // Update user account
    await this.userModel.findByIdAndUpdate(employeeId, {
      $set: {
        isActive: false,
      },
    });

    // Update employee profile with termination details
    await this.employeeProfileModel.findOneAndUpdate(
      { userId: new Types.ObjectId(employeeId) },
      {
        $set: {
          isActive: false,
          terminationDate: terminationDate,
          notes:
            `${employee.employeeProfile.notes || ''}\n\nTERMINATION:\nType: ${terminateDto.terminationType}\nReason: ${terminateDto.reason}\n${terminateDto.finalNotes || ''}`.trim(),
        },
      },
    );

    // Deactivate all shifts
    await this.employeeShiftModel.updateMany(
      { userId: new Types.ObjectId(employeeId) },
      {
        $set: {
          isActive: false,
        },
      },
    );

    // Audit log for employee termination
    if (terminatedByUserId) {
      await this.auditService.logEmployeeTerminated(
        employeeId,
        terminatedByUserId,
        '0.0.0.0', // IP address should be passed from controller
        undefined, // User agent should be passed from controller
        {
          terminationType: terminateDto.terminationType,
          terminationDate: terminationDate,
          reason: terminateDto.reason,
        },
      );
    }

    this.logger.log(`Employee terminated successfully: ${employeeId}`);

    return await this.getEmployeeById(employeeId);
  }

  /**
   * Get employee by employee number
   */
  async getEmployeeByNumber(employeeNumber: string): Promise<any> {
    const profile = await this.employeeProfileModel
      .findOne({ employeeNumber, isActive: true })
      .exec();

    if (!profile) {
      throw new NotFoundException('Employee not found');
    }

    // Extract userId as string - profile.userId is always an ObjectId when not populated
    const userId = profile.userId.toString();

    return await this.getEmployeeById(userId);
  }

  /**
   * Search employees
   */
  async searchEmployees(
    searchTerm: string,
    limit: number = 20,
  ): Promise<any[]> {
    if (!searchTerm || searchTerm.trim().length === 0) {
      return [];
    }

    const pipeline = [
      {
        $lookup: {
          from: 'employee_profiles',
          localField: '_id',
          foreignField: 'userId',
          as: 'employeeProfile',
        },
      },
      {
        $unwind: {
          path: '$employeeProfile',
          preserveNullAndEmptyArrays: true,
        },
      },
      {
        $match: {
          isActive: true,
          'employeeProfile.isActive': true,
          $or: [
            { firstName: { $regex: searchTerm, $options: 'i' } },
            { lastName: { $regex: searchTerm, $options: 'i' } },
            { email: { $regex: searchTerm, $options: 'i' } },
            { phone: { $regex: searchTerm, $options: 'i' } },
            {
              'employeeProfile.employeeNumber': {
                $regex: searchTerm,
                $options: 'i',
              },
            },
            {
              'employeeProfile.jobTitle': { $regex: searchTerm, $options: 'i' },
            },
          ],
        },
      },
      {
        $limit: Math.min(limit, 50),
      },
      {
        $lookup: {
          from: 'complexes',
          localField: 'complexId',
          foreignField: '_id',
          as: 'complex',
        },
      },
      {
        $lookup: {
          from: 'clinics',
          localField: 'clinicId',
          foreignField: '_id',
          as: 'clinic',
        },
      },
      {
        $addFields: {
          complex: { $arrayElemAt: ['$complex', 0] },
          clinic: { $arrayElemAt: ['$clinic', 0] },
        },
      },
      {
        $project: {
          _id: 1,
          firstName: 1,
          lastName: 1,
          email: 1,
          phone: 1,
          role: 1,
          userType: '$role',
          employeeNumber: '$employeeProfile.employeeNumber',
          jobTitle: '$employeeProfile.jobTitle',
          linkedComplex: {
            id: '$complex._id',
            name: '$complex.name',
          },
        },
      },
    ];

    return await this.userModel.aggregate(pipeline).exec();
  }

  /**
   * Get employee statistics
   */
  async getEmployeeStats(requestingUser?: any): Promise<EmployeeStatsDto> {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfYear = new Date(now.getFullYear(), 0, 1);

    // TENANT SCOPING: scope stats to requesting user's subscription
    let scopedUserIds: Types.ObjectId[] | null = null;
    if (requestingUser && !['super_admin', 'admin'].includes(requestingUser.role) && requestingUser.subscriptionId) {
      scopedUserIds = (await this.userModel.distinct('_id', {
        subscriptionId: new Types.ObjectId(requestingUser.subscriptionId.toString()),
      })) as Types.ObjectId[];
    }
    const userIdFilter: any = scopedUserIds ? { userId: { $in: scopedUserIds } } : {};
    const userSubMatch: any =
    requestingUser && 
    !['super_admin', 'admin'].includes(requestingUser.role) && 
    requestingUser.subscriptionId
      ? { subscriptionId: new Types.ObjectId(requestingUser.subscriptionId.toString()) }
      : {};

    const [
      totalEmployees,
      activeEmployees,
      newHiresThisMonth,
      newHiresThisYear,
      employeesByRole,
      salaryStats,
      genderStats,
      monthlyHiringTrend,
      upcomingExpirations,
    ] = await Promise.all([
      // Total employees count
      this.employeeProfileModel.countDocuments({ ...userIdFilter }),

      // Active employees count
      this.employeeProfileModel.countDocuments({ ...userIdFilter, isActive: true }),

      // New hires this month
      this.employeeProfileModel.countDocuments({
        ...userIdFilter,
        dateOfHiring: { $gte: startOfMonth },
        isActive: true,
      }),

      // New hires this year
      this.employeeProfileModel.countDocuments({
        ...userIdFilter,
        dateOfHiring: { $gte: startOfYear },
        isActive: true,
      }),

      // Employees by role
      this.userModel.aggregate([
        { $match: userSubMatch },
        {
          $lookup: {
            from: 'employee_profiles',
            localField: '_id',
            foreignField: 'userId',
            as: 'profile',
          },
        },
        {
          $unwind: '$profile',
        },
        {
          $match: { 'profile.isActive': true },
        },
        {
          $group: {
            _id: '$role',
            count: { $sum: 1 },
          },
        },
        {
          $sort: { count: -1 },
        },
      ]),

      // Salary statistics
      this.employeeProfileModel.aggregate([
        {
          $match: {
            ...userIdFilter,
            isActive: true,
            salary: { $gt: 0 },
          },
        },
        {
          $lookup: {
            from: 'users',
            localField: 'userId',
            foreignField: '_id',
            as: 'user',
          },
        },
        {
          $unwind: '$user',
        },
        {
          $group: {
            _id: null,
            averageSalary: { $avg: '$salary' },
            salaries: { $push: '$salary' },
            roleStats: {
              $push: {
                role: '$user.role',
                salary: '$salary',
              },
            },
          },
        },
      ]),

      // Gender distribution
      this.userModel.aggregate([
        { $match: userSubMatch },
        {
          $lookup: {
            from: 'employee_profiles',
            localField: '_id',
            foreignField: 'userId',
            as: 'profile',
          },
        },
        {
          $unwind: '$profile',
        },
        {
          $match: { 'profile.isActive': true },
        },
        {
          $group: {
            _id: '$gender',
            count: { $sum: 1 },
          },
        },
      ]),

      // Monthly hiring trend (last 12 months)
      this.employeeProfileModel.aggregate([
        {
          $match: {
            ...userIdFilter,
            dateOfHiring: {
              $gte: new Date(now.getFullYear() - 1, now.getMonth(), 1),
            },
          },
        },
        {
          $group: {
            _id: {
              year: { $year: '$dateOfHiring' },
              month: { $month: '$dateOfHiring' },
            },
            count: { $sum: 1 },
          },
        },
        {
          $sort: { '_id.year': 1, '_id.month': 1 },
        },
      ]),

      // Upcoming document expirations (next 30 days)
      this.employeeDocumentModel.aggregate([
        {
          $match: {
            expiryDate: {
              $gte: now,
              $lte: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
            },
            status: 'active',
            isActive: true,
          },
        },
        {
          $lookup: {
            from: 'users',
            localField: 'userId',
            foreignField: '_id',
            as: 'user',
          },
        },
        {
          $unwind: '$user',
        },
        {
          $project: {
            employeeId: '$userId',
            employeeName: {
              $concat: ['$user.firstName', ' ', '$user.lastName'],
            },
            documentType: 1,
            expiryDate: 1,
            daysUntilExpiry: {
              $divide: [
                { $subtract: ['$expiryDate', now] },
                24 * 60 * 60 * 1000,
              ],
            },
          },
        },
        {
          $sort: { expiryDate: 1 },
        },
      ]),
    ]);

    // Calculate additional statistics
    const inactiveEmployees = totalEmployees - activeEmployees;

    // Calculate average tenure
    const tenureResult = await this.employeeProfileModel.aggregate([
      {
        $match: { ...userIdFilter, isActive: true },
      },
      {
        $addFields: {
          tenureMonths: {
            $divide: [
              { $subtract: [now, '$dateOfHiring'] },
              30 * 24 * 60 * 60 * 1000, // Approximate months
            ],
          },
        },
      },
      {
        $group: {
          _id: null,
          averageTenure: { $avg: '$tenureMonths' },
        },
      },
    ]);

    const averageTenure =
      tenureResult.length > 0 ? Math.round(tenureResult[0].averageTenure) : 0;

    // Process role statistics
    const roleStats = employeesByRole.map((item) => ({
      role: item._id,
      count: item.count,
      percentage:
        totalEmployees > 0
          ? Math.round((item.count / totalEmployees) * 100)
          : 0,
    }));

    // Process salary statistics
    const salaryStatistics =
      salaryStats.length > 0
        ? {
            averageSalary: Math.round(salaryStats[0].averageSalary || 0),
            medianSalary: 0, // Would calculate from sorted salaries array
            salaryRangeByRole: [], // Would group by role and calculate ranges
          }
        : {
            averageSalary: 0,
            medianSalary: 0,
            salaryRangeByRole: [],
          };

    // Process gender distribution
    const genderDistribution = {
      male: 0,
      female: 0,
      other: 0,
      malePercentage: 0,
      femalePercentage: 0,
    };

    genderStats.forEach((stat) => {
      genderDistribution[stat._id] = stat.count;
    });

    if (totalEmployees > 0) {
      genderDistribution.malePercentage = Math.round(
        (genderDistribution.male / totalEmployees) * 100,
      );
      genderDistribution.femalePercentage = Math.round(
        (genderDistribution.female / totalEmployees) * 100,
      );
    }

    // Process monthly hiring trend
    const monthNames = [
      'Jan',
      'Feb',
      'Mar',
      'Apr',
      'May',
      'Jun',
      'Jul',
      'Aug',
      'Sep',
      'Oct',
      'Nov',
      'Dec',
    ];
    const monthlyTrend = monthlyHiringTrend.map((item) => ({
      month: `${monthNames[item._id.month - 1]} ${item._id.year}`,
      count: item.count,
    }));

    return {
      totalEmployees,
      activeEmployees,
      inactiveEmployees,
      newHiresThisMonth,
      newHiresThisYear,
      averageTenure,
      employeesByRole: roleStats,
      employeesByDepartment: [], // Would implement if department schema exists
      upcomingDocumentExpirations: upcomingExpirations,
      salaryStatistics,
      genderDistribution,
      ageDistribution: [], // Would calculate age ranges
      monthlyHiringTrend: monthlyTrend,
    };
  }

  /**
   * Create employee document
   */
  async createEmployeeDocument(
    createDocumentDto: CreateEmployeeDocumentDto,
    uploadedByUserId?: string,
  ): Promise<any> {
    // Validate userId is provided
    if (!createDocumentDto.userId) {
      throw new BadRequestException({
        message: {
          ar: 'معرف الموظف مطلوب',
          en: 'Employee ID is required',
        },
      });
    }

    // Validate employee exists
    const employee = await this.getEmployeeById(createDocumentDto.userId);
    if (!employee) {
      throw new NotFoundException('Employee not found');
    }

    // Validate uploadedBy is provided
    if (!uploadedByUserId) {
      throw new BadRequestException({
        message: {
          ar: 'معرف المستخدم الذي قام بالرفع مطلوب',
          en: 'Uploaded by user ID is required',
        },
        code: 'UPLOADED_BY_REQUIRED',
      });
    }

    const documentData = {
      ...createDocumentDto,
      userId: new Types.ObjectId(createDocumentDto.userId),
      uploadedBy: new Types.ObjectId(uploadedByUserId),
      status: 'active',
      isVerified: false,
      isActive: true,
      issueDate: createDocumentDto.issueDate
        ? new Date(createDocumentDto.issueDate)
        : undefined,
      expiryDate: createDocumentDto.expiryDate
        ? new Date(createDocumentDto.expiryDate)
        : undefined,
    };
    const existingDocuments = await this.employeeDocumentModel
      .find({
        userId: new Types.ObjectId(createDocumentDto.userId),
        documentType: createDocumentDto.documentType,
        isActive: true,
      })
      .sort({ updatedAt: -1, _id: -1 })
      .exec();

    const [primaryDocument, ...duplicateDocuments] = existingDocuments;

    if (duplicateDocuments.length > 0) {
      await this.employeeDocumentModel.updateMany(
        {
          _id: {
            $in: duplicateDocuments.map((doc) => doc._id),
          },
        },
        {
          $set: {
            isActive: false,
            status: 'archived',
          },
        },
      );
    }

    if (primaryDocument) {
      return await this.employeeDocumentModel
        .findByIdAndUpdate(
          primaryDocument._id,
          { $set: documentData },
          { new: true, runValidators: true },
        )
        .exec();
    }

    const document = new this.employeeDocumentModel(documentData);
    return await document.save();
  }

  /**
   * Update employee document
   */
  async updateEmployeeDocument(
    documentId: string,
    updateDocumentDto: UpdateEmployeeDocumentDto,
    updatedByUserId?: string,
  ): Promise<any> {
    if (!Types.ObjectId.isValid(documentId)) {
      throw new BadRequestException('Invalid document ID format');
    }

    const updateData: any = {
      ...updateDocumentDto,
      expiryDate: updateDocumentDto.expiryDate
        ? new Date(updateDocumentDto.expiryDate)
        : undefined,
    };

    if (updateDocumentDto.isVerified && updatedByUserId) {
      updateData.verifiedBy = new Types.ObjectId(updatedByUserId);
      updateData.verifiedAt = new Date();
    }

    const document = await this.employeeDocumentModel
      .findByIdAndUpdate(
        documentId,
        { $set: updateData },
        { new: true, runValidators: true },
      )
      .exec();

    if (!document) {
      throw new NotFoundException('Employee document not found');
    }

    return document;
  }

  /**
   * Get employee documents
   */
  async getEmployeeDocuments(employeeId: string): Promise<any[]> {
    if (!Types.ObjectId.isValid(employeeId)) {
      throw new BadRequestException('Invalid employee ID format');
    }

    return await this.employeeDocumentModel
      .find({
        userId: new Types.ObjectId(employeeId),
        isActive: true,
        status: { $ne: 'archived' },
      })
      .populate('uploadedBy', 'firstName lastName')
      .populate('verifiedBy', 'firstName lastName')
      .sort({ createdAt: -1 })
      .exec();
  }

  /**
   * Create employee shift
   */
  async createEmployeeShift(
    createShiftDto: CreateEmployeeShiftDto,
  ): Promise<any> {
    // Validate userId is provided
    if (!createShiftDto.userId) {
      throw new BadRequestException({
        message: {
          ar: 'معرف الموظف مطلوب',
          en: 'Employee ID is required',
        },
      });
    }

    // Validate employee exists
    const employee = await this.getEmployeeById(createShiftDto.userId);
    if (!employee) {
      throw new NotFoundException('Employee not found');
    }

    // Validate shift times
    const startTime = createShiftDto.startTime.split(':');
    const endTime = createShiftDto.endTime.split(':');
    const startMinutes = parseInt(startTime[0]) * 60 + parseInt(startTime[1]);
    const endMinutes = parseInt(endTime[0]) * 60 + parseInt(endTime[1]);

    if (startMinutes >= endMinutes) {
      throw new BadRequestException('End time must be after start time');
    }

    // Check for overlapping shifts on the same day
    const existingShift = await this.employeeShiftModel.findOne({
      userId: new Types.ObjectId(createShiftDto.userId),
      dayOfWeek: createShiftDto.dayOfWeek,
      entityType: createShiftDto.entityType,
      entityId: new Types.ObjectId(createShiftDto.entityId),
      isActive: true,
    });

    if (existingShift) {
      throw new ConflictException(
        `Employee already has a shift on ${createShiftDto.dayOfWeek} for this ${createShiftDto.entityType}`,
      );
    }

    const shiftData = {
      ...createShiftDto,
      userId: new Types.ObjectId(createShiftDto.userId),
      entityId: new Types.ObjectId(createShiftDto.entityId),
      breakDurationMinutes: createShiftDto.breakDurationMinutes || 0,
      isActive: true,
    };

    const shift = new this.employeeShiftModel(shiftData);
    return await shift.save();
  }

  /**
   * Get employee shifts
   */
  async getEmployeeShifts(employeeId: string): Promise<any[]> {
    if (!Types.ObjectId.isValid(employeeId)) {
      throw new BadRequestException('Invalid employee ID format');
    }

    return await this.employeeShiftModel
      .find({
        userId: new Types.ObjectId(employeeId),
        isActive: true,
      })
      .populate('entityId', 'name')
      .sort({ dayOfWeek: 1, startTime: 1 })
      .exec();
  }

  /**
   * Bulk employee actions
   */
  async bulkEmployeeAction(
    bulkActionDto: BulkEmployeeActionDto,
    actionByUserId?: string,
  ): Promise<{ success: number; failed: number; errors: string[] }> {
    const { employeeIds, action, reason, effectiveDate } = bulkActionDto;
    let success = 0;
    let failed = 0;
    const errors: string[] = [];

    for (const employeeId of employeeIds) {
      try {
        switch (action) {
          case 'activate':
            await this.updateEmployee(
              employeeId,
              { isActive: true },
              actionByUserId,
            );
            break;
          case 'deactivate':
            await this.updateEmployee(
              employeeId,
              { isActive: false },
              actionByUserId,
            );
            break;
          case 'terminate':
            if (!effectiveDate || !reason) {
              throw new BadRequestException(
                'Termination requires effective date and reason',
              );
            }
            await this.terminateEmployee(
              employeeId,
              {
                terminationDate: effectiveDate,
                terminationType: 'other',
                reason,
              },
              actionByUserId,
            );
            break;
          case 'export':
            // Export logic would be implemented here
            break;
        }
        success++;
      } catch (error) {
        failed++;
        errors.push(`Employee ${employeeId}: ${error.message}`);
      }
    }

    return { success, failed, errors };
  }

  /**
   * Get employees for dropdown (only active users)
   *
   * Business Rule: BZR-q4f3e1b8 - Deactivated user restrictions in dropdowns
   * Requirements: 3.2
   * Design: Section 3.3.1
   *
   * Returns only active employees for dropdown selection, with optional filtering
   * by complex, clinic, or role. This ensures deactivated users are automatically
   * excluded from assignment dropdowns.
   *
   * @param {Object} [filters] - Optional filters for the query
   * @param {string} [filters.complexId] - Filter by complex ID
   * @param {string} [filters.clinicId] - Filter by clinic ID
   * @param {string} [filters.role] - Filter by user role
   * @returns {Promise<any>} Standardized response with active employees
   *
   * @example
   * // Get all active employees
   * const result = await this.getEmployeesForDropdown();
   *
   * @example
   * // Get active doctors in a specific complex
   * const result = await this.getEmployeesForDropdown({
   *   role: 'doctor',
   *   complexId: 'complex123'
   * });
   *
   * @example
   * // Get active employees in a specific clinic
   * const result = await this.getEmployeesForDropdown({
   *   clinicId: 'clinic456'
   * });
   */
  async getEmployeesForDropdown(filters?: {
    complexId?: string;
    clinicId?: string;
    role?: string;
  }): Promise<any> {
    this.logger.log('Getting employees for dropdown with filters:', filters);

    // Build aggregation pipeline
    const pipeline: any[] = [
      // Join with employee profiles
      {
        $lookup: {
          from: 'employee_profiles',
          localField: '_id',
          foreignField: 'userId',
          as: 'employeeProfile',
        },
      },
      // Unwind employee profile (only include users with profiles)
      {
        $unwind: {
          path: '$employeeProfile',
          preserveNullAndEmptyArrays: true,
        },
      },
      // Filter: Only active users and active employee profiles
      {
        $match: {
          isActive: true,
          'employeeProfile.isActive': true,
        },
      },
    ];

    // Apply optional filters
    const additionalFilters: any = {};

    if (filters?.role) {
      additionalFilters.role = filters.role;
    }

    if (filters?.complexId) {
      additionalFilters.complexId = new Types.ObjectId(filters.complexId);
    }

    if (filters?.clinicId) {
      additionalFilters.clinicId = new Types.ObjectId(filters.clinicId);
    }

    // Add additional filters if any exist
    if (Object.keys(additionalFilters).length > 0) {
      pipeline.push({
        $match: additionalFilters,
      });
    }

    // Project only necessary fields for dropdown
    pipeline.push({
      $project: {
        _id: 1,
        firstName: 1,
        lastName: 1,
        email: 1,
        role: 1,
        phone: 1,
        employeeNumber: '$employeeProfile.employeeNumber',
        jobTitle: '$employeeProfile.jobTitle',
        profilePictureUrl: '$employeeProfile.profilePictureUrl',
      },
    });

    // Sort by name
    pipeline.push({
      $sort: { firstName: 1, lastName: 1 },
    });

    // Execute aggregation
    const employees = await this.userModel.aggregate(pipeline).exec();

    this.logger.log(`Found ${employees.length} active employees for dropdown`);

    // Return standardized response using ResponseBuilder
    return ResponseBuilder.success(employees);
  }
}
