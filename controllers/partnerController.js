const User = require('../models/User');
const Partner = require('../models/Partner');
const AdminProfile = require('../models/AdminProfile');
exports.getAllPartners = async (req, res) => {
  try {
    const partners = await Partner.find()
      .populate('user', 'name email createdAt isActive')
      .sort({ createdAt: -1 });
    
    res.json({
      success: true,
      partners
    });
  } catch (error) {
    console.error('Error fetching partners:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while fetching partners'
    });
  }
};
exports.getPartnerDetails = async (req, res) => {
  try {
    const { partnerId } = req.params;
    
    const partner = await Partner.findById(partnerId)
      .populate('user', 'name email createdAt isActive')
      .populate('conversionHistory.convertedBy', 'firstName lastName');
    
    if (!partner) {
      return res.status(404).json({
        success: false,
        message: 'Partner not found'
      });
    }
    
    res.json({
      success: true,
      partner
    });
  } catch (error) {
    console.error('Error fetching partner details:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while fetching partner details'
    });
  }
};
exports.createPartner = async (req, res) => {
  try {
    const {
      name,
      email,
      password,
      partnerName,
      category,
      categoryDescription,
      adminContactPerson,
      contactNumber,
      coursesOffered,
      location,
      gstNumber,
      panNumber,
      website,
      establishedYear,
      description
    } = req.body;
    if (!name || !email || !password || !partnerName || !category || !adminContactPerson || !contactNumber || !panNumber) {
      return res.status(400).json({
        success: false,
        message: 'Please provide all required fields'
      });
    }
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({
        success: false,
        message: 'User with this email already exists'
      });
    }
    const newUser = new User({
      name,
      email,
      password,
      role: 'partner',
      isActive: true
    });

    await newUser.save();
    const newPartner = new Partner({
      user: newUser._id,
      partnerName,
      category,
      categoryDescription,
      adminContactPerson,
      contactNumber,
      email,
      coursesOffered: coursesOffered || [],
      location,
      gstNumber,
      panNumber,
      website,
      establishedYear,
      description
    });

    await newPartner.save();

    res.status(201).json({
      success: true,
      message: 'Partner created successfully',
      partner: {
        id: newPartner._id,
        partnerName: newPartner.partnerName,
        category: newPartner.category,
        email: newPartner.email
      }
    });
  } catch (error) {
    console.error('Error creating partner:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while creating partner'
    });
  }
};
exports.updatePartner = async (req, res) => {
  try {
    const { partnerId } = req.params;
    const updateData = req.body;
    
    const partner = await Partner.findById(partnerId);
    if (!partner) {
      return res.status(404).json({
        success: false,
        message: 'Partner not found'
      });
    }
    Object.keys(updateData).forEach(key => {
      if (key !== 'user' && updateData[key] !== undefined) {
        partner[key] = updateData[key];
      }
    });
    if (updateData.name || updateData.email) {
      const user = await User.findById(partner.user);
      if (user) {
        if (updateData.name) user.name = updateData.name;
        if (updateData.email) user.email = updateData.email;
        await user.save();
      }
    }

    await partner.save();

    res.json({
      success: true,
      message: 'Partner updated successfully',
      partner
    });
  } catch (error) {
    console.error('Error updating partner:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while updating partner'
    });
  }
};
exports.convertRecruiterToPartner = async (req, res) => {
  try {
      const { recruiterId } = req.params;
      const {
          partnerName,
          category,
          categoryDescription,
          adminContactPerson,
          contactNumber,
          email,
          coursesOffered,
          location,
          gstNumber,
          panNumber,
          website,
          establishedYear,
          description,
          reason
      } = req.body;

      // First, find the user without populate
      const user = await User.findOne({ _id: recruiterId, role: 'recruiter' });
      if (!user) {
          return res.status(404).json({
              success: false,
              message: 'Recruiter not found'
          });
      }

      // Then, find the admin profile separately
      const adminProfile = await AdminProfile.findOne({ user: user._id });

      const partnerData = {
          user: user._id,
          partnerName: partnerName || adminProfile?.companyName || user.company?.name || user.name,
          category,
          categoryDescription: category === 'Others' ? categoryDescription : undefined,
          adminContactPerson: adminContactPerson || user.name,
          contactNumber: contactNumber || adminProfile?.contactPhone || user.company?.phone,
          email: email || user.email,
          coursesOffered: coursesOffered || [],
          location: location || {
              address: adminProfile?.location || user.company?.location || '',
              city: '',
              state: ''
          },
          gstNumber,
          panNumber,
          website: website || adminProfile?.website || user.company?.website,
          establishedYear,
          description: description || adminProfile?.description || user.company?.description,
          previousRole: 'recruiter'
      };

      const newPartner = new Partner(partnerData);
      newPartner.addConversionHistory('recruiter', 'partner', req.user.id, reason);
      
      // Update user role
      user.role = 'partner';
      await user.save();
      await newPartner.save();

      res.json({
          success: true,
          message: 'Recruiter successfully converted to partner',
          partner: newPartner
      });
  } catch (error) {
      console.error('Error converting recruiter to partner:', error);
      res.status(500).json({
          success: false,
          message: 'Server error while converting recruiter to partner'
      });
  }
};
exports.convertPartnerToRecruiter = async (req, res) => {
  try {
    const { partnerId } = req.params;
    const { reason, companyName, position, website } = req.body;
    const partner = await Partner.findById(partnerId).populate('user');
    if (!partner) {
      return res.status(404).json({
        success: false,
        message: 'Partner not found'
      });
    }

    const user = partner.user;
    let adminProfile = await AdminProfile.findOne({ user: user._id });
    
    if (!adminProfile) {
      adminProfile = new AdminProfile({
        user: user._id,
        companyName: companyName || partner.partnerName,
        position: position || 'Manager',
        website: website || partner.website,
        location: partner.location?.address,
        description: partner.description,
        contactEmail: user.email,
        contactPhone: partner.contactNumber,
        isComplete: false
      });
    } else {
      adminProfile.companyName = companyName || partner.partnerName;
      adminProfile.position = position || adminProfile.position;
      adminProfile.website = website || partner.website;
      adminProfile.updatedAt = new Date();
    }
    user.role = 'recruiter';
    user.company = {
      name: companyName || partner.partnerName,
      position: position || 'Manager',
      website: website || partner.website
    };
    partner.addConversionHistory('partner', 'recruiter', req.user.id, reason);

    await user.save();
    await adminProfile.save();
    await partner.save();

    res.json({
      success: true,
      message: 'Partner successfully converted to recruiter',
      recruiter: {
        id: user._id,
        name: user.name,
        email: user.email,
        company: user.company
      }
    });
  } catch (error) {
    console.error('Error converting partner to recruiter:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while converting partner to recruiter'
    });
  }
};
exports.deletePartner = async (req, res) => {
  try {
    const { partnerId } = req.params;
    
    const partner = await Partner.findById(partnerId);
    if (!partner) {
      return res.status(404).json({
        success: false,
        message: 'Partner not found'
      });
    }
    await User.findByIdAndDelete(partner.user);
    await Partner.findByIdAndDelete(partnerId);

    res.json({
      success: true,
      message: 'Partner deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting partner:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while deleting partner'
    });
  }
};
exports.updatePartnerStatus = async (req, res) => {
  try {
    const { partnerId } = req.params;
    const { status } = req.body;
    
    if (status === undefined) {
      return res.status(400).json({
        success: false,
        message: 'Status is required'
      });
    }
    
    const partner = await Partner.findById(partnerId);
    if (!partner) {
      return res.status(404).json({
        success: false,
        message: 'Partner not found'
      });
    }
    await User.findByIdAndUpdate(partner.user, { isActive: status });
    
    partner.isActive = status;
    await partner.save();
    
    res.json({
      success: true,
      message: `Partner ${status ? 'activated' : 'deactivated'} successfully`,
      status: partner.isActive
    });
  } catch (error) {
    console.error('Error updating partner status:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while updating partner status'
    });
  }
};
exports.getPartnerStats = async (req, res) => {
  try {
    const totalPartners = await Partner.countDocuments();
    const activePartners = await Partner.countDocuments({ isActive: true });
    const verifiedPartners = await Partner.countDocuments({ isVerified: true });
    const partnersByCategory = await Partner.aggregate([
      {
        $group: {
          _id: '$category',
          count: { $sum: 1 }
        }
      }
    ]);
    const recentPartners = await Partner.find()
      .populate('user', 'name email createdAt')
      .sort({ createdAt: -1 })
      .limit(5)
      .select('partnerName category createdAt');

    res.json({
      success: true,
      stats: {
        totalPartners,
        activePartners,
        verifiedPartners,
        partnersByCategory,
        recentPartners
      }
    });
  } catch (error) {
    console.error('Error fetching partner stats:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while fetching partner statistics'
    });
  }
};