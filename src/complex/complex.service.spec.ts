import { Test, TestingModule } from '@nestjs/testing';
import { ComplexService } from './complex.service';
import { getModelToken, getConnectionToken } from '@nestjs/mongoose';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { SubscriptionService } from '../subscription/subscription.service';
import { DepartmentService } from '../department/department.service';
import { Types } from 'mongoose';

describe('ComplexService - Create Complex Enhancement', () => {
  let service: ComplexService;
  let mockComplexModel: any;
  let mockSubscriptionService: any;
  let mockDepartmentService: any;
  let mockConnection: any;

  beforeEach(async () => {
    // Mock Complex Model
    mockComplexModel = {
      countDocuments: jest.fn(),
      findById: jest.fn(),
      findOne: jest.fn(),
      find: jest.fn(),
      findByIdAndDelete: jest.fn(),
      db: {
        collection: jest.fn().mockReturnValue({
          findOne: jest.fn(),
          countDocuments: jest.fn(),
        }),
      },
    };

    // Mock Subscription Service
    mockSubscriptionService = {
      isSubscriptionActive: jest.fn(),
      getSubscriptionWithPlan: jest.fn(),
    };

    mockDepartmentService = {
      getDepartmentsByComplex: jest.fn(),
    };

    // Mock Database Connection
    mockConnection = {
      startSession: jest.fn().mockResolvedValue({
        startTransaction: jest.fn(),
        commitTransaction: jest.fn(),
        abortTransaction: jest.fn(),
        endSession: jest.fn(),
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ComplexService,
        {
          provide: getModelToken('Complex'),
          useValue: mockComplexModel,
        },
        {
          provide: getConnectionToken(),
          useValue: mockConnection,
        },
        {
          provide: SubscriptionService,
          useValue: mockSubscriptionService,
        },
        {
          provide: DepartmentService,
          useValue: mockDepartmentService,
        },
      ],
    }).compile();

    service = module.get<ComplexService>(ComplexService);
  });

  describe('createComplex', () => {
    it('should set default status to active', async () => {
      const createDto = {
        subscriptionId: new Types.ObjectId().toString(),
        name: 'Test Complex',
        email: 'test@example.com',
        phone: '0501234567', // Valid Saudi phone number
      };

      mockSubscriptionService.isSubscriptionActive.mockResolvedValue(true);
      mockSubscriptionService.getSubscriptionWithPlan.mockResolvedValue({
        plan: { maxComplexes: 5 },
      });
      mockComplexModel.countDocuments.mockResolvedValue(0);

      const mockSave = jest.fn().mockResolvedValue({
        _id: new Types.ObjectId(),
        ...createDto,
        status: 'active',
      });

      const mockPopulate = jest.fn().mockReturnThis();
      const mockExec = jest.fn().mockResolvedValue({
        _id: new Types.ObjectId(),
        ...createDto,
        status: 'active',
      });

      mockComplexModel.findById = jest.fn().mockReturnValue({
        populate: mockPopulate,
        exec: mockExec,
      });

      // Create a mock constructor that returns an object with save method
      const MockComplexConstructor = jest.fn().mockImplementation(() => ({
        save: mockSave,
        _id: new Types.ObjectId(),
        personInChargeId: null,
      }));

      mockComplexModel = Object.assign(
        MockComplexConstructor,
        mockComplexModel,
      );

      // Re-create service with updated mock
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          ComplexService,
          {
            provide: getModelToken('Complex'),
            useValue: mockComplexModel,
          },
          {
            provide: getConnectionToken(),
            useValue: mockConnection,
          },
          {
            provide: SubscriptionService,
            useValue: mockSubscriptionService,
          },
          {
            provide: DepartmentService,
            useValue: mockDepartmentService,
          },
        ],
      }).compile();

      service = module.get<ComplexService>(ComplexService);

      const result = await service.createComplex(createDto as any);

      expect(result).toBeDefined();
      expect(result.status).toBe('active');
    });

    it('should throw COMPLEX_008 error for inactive subscription', async () => {
      const createDto = {
        subscriptionId: new Types.ObjectId().toString(),
        name: 'Test Complex',
      };

      mockSubscriptionService.isSubscriptionActive.mockResolvedValue(false);

      await expect(service.createComplex(createDto as any)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw COMPLEX_009 error for invalid email', async () => {
      const createDto = {
        subscriptionId: new Types.ObjectId().toString(),
        name: 'Test Complex',
        email: 'invalid-email',
      };

      mockSubscriptionService.isSubscriptionActive.mockResolvedValue(true);
      mockSubscriptionService.getSubscriptionWithPlan.mockResolvedValue({
        plan: { maxComplexes: 5 },
      });
      mockComplexModel.countDocuments.mockResolvedValue(0);

      await expect(service.createComplex(createDto as any)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw COMPLEX_010 error for invalid phone', async () => {
      const createDto = {
        subscriptionId: new Types.ObjectId().toString(),
        name: 'Test Complex',
        phone: 'invalid',
      };

      mockSubscriptionService.isSubscriptionActive.mockResolvedValue(true);
      mockSubscriptionService.getSubscriptionWithPlan.mockResolvedValue({
        plan: { maxComplexes: 5 },
      });
      mockComplexModel.countDocuments.mockResolvedValue(0);

      await expect(service.createComplex(createDto as any)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('softDeleteComplex', () => {
    it('should throw COMPLEX_006 error when complex not found', async () => {
      const complexId = new Types.ObjectId().toString();

      mockComplexModel.findById = jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue(null),
      });

      await expect(service.softDeleteComplex(complexId)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw COMPLEX_003 error when complex has active clinics', async () => {
      const complexId = new Types.ObjectId().toString();

      const mockComplex = {
        _id: complexId,
        name: 'Test Complex',
        status: 'active',
        save: jest.fn(),
      };

      mockComplexModel.findById = jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue(mockComplex),
      });

      // Mock calculateClinicsAssigned to return > 0
      mockComplexModel.db.collection = jest.fn().mockReturnValue({
        countDocuments: jest.fn().mockResolvedValue(2), // 2 active clinics
      });

      await expect(service.softDeleteComplex(complexId)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should set deletedAt when no active clinics exist', async () => {
      const complexId = new Types.ObjectId().toString();

      const mockComplex = {
        _id: complexId,
        name: 'Test Complex',
        status: 'active',
        deletedAt: null,
        save: jest.fn().mockResolvedValue(true),
      };

      mockComplexModel.findById = jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue(mockComplex),
      });

      // Mock calculateClinicsAssigned to return 0
      mockComplexModel.db.collection = jest.fn().mockReturnValue({
        countDocuments: jest.fn().mockResolvedValue(0), // No active clinics
      });

      const result = await service.softDeleteComplex(complexId);

      expect(result.success).toBe(true);
      expect(result.message).toHaveProperty('ar');
      expect(result.message).toHaveProperty('en');
      expect(mockComplex.save).toHaveBeenCalled();
      expect(mockComplex.deletedAt).toBeDefined();
    });

    it('should preserve complex data after soft delete', async () => {
      const complexId = new Types.ObjectId().toString();

      const mockComplex = {
        _id: complexId,
        name: 'Test Complex',
        email: 'test@example.com',
        status: 'active',
        deletedAt: null,
        save: jest.fn().mockResolvedValue(true),
      };

      mockComplexModel.findById = jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue(mockComplex),
      });

      // Mock calculateClinicsAssigned to return 0
      mockComplexModel.db.collection = jest.fn().mockReturnValue({
        countDocuments: jest.fn().mockResolvedValue(0),
      });

      await service.softDeleteComplex(complexId);

      // Verify data is preserved
      expect(mockComplex.name).toBe('Test Complex');
      expect(mockComplex.email).toBe('test@example.com');
      expect(mockComplex.status).toBe('active');
      expect(mockComplex.deletedAt).toBeDefined();
    });
  });

  describe('listComplexes', () => {
    it('should keep owners at subscription scope while still including legacy null organization complexes', async () => {
      const ownerUser = {
        role: 'owner',
        subscriptionId: new Types.ObjectId().toString(),
        organizationId: new Types.ObjectId().toString(),
      };

      const findChain = {
        sort: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        populate: jest.fn().mockReturnThis(),
        lean: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([]),
      };

      mockComplexModel.find.mockReturnValue(findChain);
      mockComplexModel.countDocuments.mockReturnValue({
        exec: jest.fn().mockResolvedValue(0),
      });

      await service.listComplexes({}, ownerUser);

      expect(mockComplexModel.find).toHaveBeenCalledWith({
        deletedAt: null,
        subscriptionId: {
          $in: [new Types.ObjectId(ownerUser.subscriptionId), ownerUser.subscriptionId],
        },
        $or: [
          { organizationId: new Types.ObjectId(ownerUser.organizationId) },
          { organizationId: null },
          { organizationId: { $exists: false } },
        ],
      });
    });
  });

  describe('getComplexesForDropdown', () => {
    it('should include legacy null organization complexes for owners', async () => {
      const ownerUser = {
        role: 'owner',
        subscriptionId: new Types.ObjectId().toString(),
        organizationId: new Types.ObjectId().toString(),
      };

      mockComplexModel.find.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        sort: jest.fn().mockReturnThis(),
        lean: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([]),
      });

      await service.getComplexesForDropdown(ownerUser);

      expect(mockComplexModel.find).toHaveBeenCalledWith({
        deletedAt: null,
        status: 'active',
        subscriptionId: {
          $in: [new Types.ObjectId(ownerUser.subscriptionId), ownerUser.subscriptionId],
        },
        $or: [
          { organizationId: new Types.ObjectId(ownerUser.organizationId) },
          { organizationId: null },
          { organizationId: { $exists: false } },
        ],
      });
    });
  });
});
